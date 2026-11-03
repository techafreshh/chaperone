use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::AccountId;


/// Stored status for a payment request that passed the active and
/// allowance gates.
pub(crate) const STAGED: &str = "staged";
/// Stored status for a payment request the verifier judged consistent.
pub(crate) const PAID: &str = "paid";
/// Stored status for a payment request the verifier judged inconsistent.
pub(crate) const HELD: &str = "held";
/// Rejection reason for a held request the owner declined to release.
pub(crate) const REASON_HOLD_REJECTED: &str = "HoldRejected";
/// Stored status for a payment request rejected at intake.
pub(crate) const REJECTED: &str = "rejected";
/// Rejection reason for requests from a deactivated agent.
pub(crate) const REASON_AGENT_INACTIVE: &str = "AgentInactive";
/// Rejection reason for requests that would exceed the daily allowance.
pub(crate) const REASON_EXCEEDS_DAILY_ALLOWANCE: &str = "ExceedsDailyAllowance";
/// Rejection reason for requests above the agent's per-payment cap.
pub(crate) const REASON_EXCEEDS_PER_PAYMENT_CAP: &str = "ExceedsPerPaymentCap";
/// Rejection reason for requests to a payee outside the agent's allowlist.
pub(crate) const REASON_PAYEE_NOT_ALLOWLISTED: &str = "PayeeNotAllowlisted";
/// Rejection reason for requests citing an unregistered purpose ref.
pub(crate) const REASON_PURPOSE_REF_NOT_FOUND: &str = "PurposeRefNotFound";
/// Rejection reason for requests citing a closed purpose ref.
pub(crate) const REASON_PURPOSE_REF_CLOSED: &str = "PurposeRefClosed";
/// Rejection reason for requests above the purpose ref's max amount.
pub(crate) const REASON_EXCEEDS_PURPOSE_REF_CAP: &str = "ExceedsPurposeRefCap";

/// On-chain payment request (contract storage; doubles as the
/// `get_request` view since the id is embedded).
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PaymentRequest {
    pub request_id: u64,
    pub agent_id: AccountId,
    pub payee: AccountId,
    pub amount_yocto: U128,
    pub purpose_ref: String,
    pub vendor: String,
    pub status: String,
    pub reason: Option<String>,
}

/// Return value of `request_payment`: the allocated id plus the intake
/// outcome. Rejections are recorded on-chain and retrievable via
/// `get_request`.
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PaymentOutcome {
    pub request_id: u64,
    pub status: String,
    pub reason: Option<String>,
}

pub(crate) use crate::events::{log_request_created, log_request_rejected};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Guard;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    use crate::policy::NANOS_PER_DAY;

    const OWNER: &str = "owner.testnet";
    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const ALLOWANCE: u128 = 50_000_000_000_000_000_000_000_000;

    fn owner_id() -> AccountId {
        OWNER.parse().unwrap()
    }

    fn set_predecessor(account_id: &str) {
        let context = VMContextBuilder::new()
            .predecessor_account_id(account_id.parse().unwrap())
            .build();
        testing_env!(context);
    }

    fn fresh_guard() -> Guard {
        set_predecessor(OWNER);
        Guard::new(owner_id())
    }

    fn register(guard: &mut Guard, agent: &str, allowance: u128) {
        guard.register_agent(
            agent.parse().unwrap(),
            U128::from(allowance),
            U128::from(allowance),
            vec!["payee.near".parse().unwrap()],
        );
        // Intake now enforces allowlist + purpose-ref checks, so the shared
        // fixture provisions the refs its requests cite (idempotently, since
        // several tests register two agents).
        for ref_id in ["ref-1", "ref-2"] {
            if guard.get_purpose_ref(ref_id.to_string()).is_none() {
                guard.register_purpose_ref(
                    ref_id.to_string(),
                    "Vendor".to_string(),
                    U128::from(1_000 * ONE_NEAR),
                );
            }
        }
    }

    fn request_as(guard: &mut Guard, caller: &str, payee: &str, amount: u128) -> PaymentOutcome {
        let context = VMContextBuilder::new()
            .predecessor_account_id(caller.parse().unwrap())
            .build();
        testing_env!(context);
        guard.request_payment(
            payee.parse().unwrap(),
            U128::from(amount),
            "ref-1".to_string(),
            "Vendor".to_string(),
        )
    }

    #[test]
    fn killed_agent_request_yields_agent_inactive() {
        let mut guard = fresh_guard();
        register(&mut guard, "agent-1.near", ALLOWANCE);

        set_predecessor(OWNER);
        guard.set_agent_active("agent-1.near".parse().unwrap(), false);
        let view = guard
            .get_agent("agent-1.near".parse().unwrap())
            .expect("agent must be registered");
        assert!(!view.active);

        let outcome = request_as(&mut guard, "agent-1.near", "payee.near", ONE_NEAR);
        assert_eq!(outcome.request_id, 1);
        assert_eq!(outcome.status, REJECTED);
        assert_eq!(outcome.reason, Some(REASON_AGENT_INACTIVE.to_string()));

        let stored = guard
            .get_request(outcome.request_id)
            .expect("rejection must be recorded");
        assert_eq!(stored.status, REJECTED);
        assert_eq!(stored.reason, Some(REASON_AGENT_INACTIVE.to_string()));
        assert_eq!(stored.agent_id.as_str(), "agent-1.near");
    }

    #[test]
    fn live_agent_stages_while_other_is_killed() {
        let mut guard = fresh_guard();
        register(&mut guard, "agent-1.near", ALLOWANCE);
        register(&mut guard, "agent-2.near", ALLOWANCE);

        set_predecessor(OWNER);
        guard.set_agent_active("agent-1.near".parse().unwrap(), false);

        let outcome = request_as(&mut guard, "agent-2.near", "payee.near", ONE_NEAR);
        assert_eq!(outcome.status, STAGED);
        assert_eq!(outcome.reason, None);

        let stored = guard
            .get_request(outcome.request_id)
            .expect("staged request must be stored");
        assert_eq!(stored.status, STAGED);
        assert_eq!(stored.amount_yocto, U128::from(ONE_NEAR));
    }

    #[test]
    fn allowance_overflow_yields_exceeds_daily_allowance() {
        let mut guard = fresh_guard();
        register(&mut guard, "agent-1.near", 5 * ONE_NEAR);

        let first = request_as(&mut guard, "agent-1.near", "payee.near", 5 * ONE_NEAR);
        assert_eq!(first.status, STAGED);

        let second = request_as(&mut guard, "agent-1.near", "payee.near", 1);
        assert_eq!(second.status, REJECTED);
        assert_eq!(
            second.reason,
            Some(REASON_EXCEEDS_DAILY_ALLOWANCE.to_string())
        );

        let stored = guard
            .get_request(second.request_id)
            .expect("rejection must be recorded");
        assert_eq!(
            stored.reason,
            Some(REASON_EXCEEDS_DAILY_ALLOWANCE.to_string())
        );
    }

    #[test]
    #[should_panic(expected = "Agent not registered")]
    fn unknown_caller_panics() {
        let mut guard = fresh_guard();
        register(&mut guard, "agent-1.near", ALLOWANCE);
        request_as(&mut guard, "ghost.near", "payee.near", ONE_NEAR);
    }

    #[test]
    fn request_ids_are_monotonic_from_one() {
        let mut guard = fresh_guard();
        register(&mut guard, "agent-1.near", 10 * ONE_NEAR);
        register(&mut guard, "agent-2.near", 10 * ONE_NEAR);

        set_predecessor(OWNER);
        guard.set_agent_active("agent-1.near".parse().unwrap(), false);

        // Rejection still allocates an id.
        let rejected = request_as(&mut guard, "agent-1.near", "payee.near", ONE_NEAR);
        assert_eq!(rejected.request_id, 1);

        let first = request_as(&mut guard, "agent-2.near", "payee.near", ONE_NEAR);
        assert_eq!(first.request_id, 2);

        let second = request_as(&mut guard, "agent-2.near", "payee.near", ONE_NEAR);
        assert_eq!(second.request_id, 3);

        assert!(guard.get_request(99).is_none());
    }

    #[test]
    fn spend_resets_on_utc_day_change_and_request_succeeds() {
        let mut guard = fresh_guard();
        register(&mut guard, "agent-1.near", 5 * ONE_NEAR);

        let staged = request_as(&mut guard, "agent-1.near", "payee.near", 5 * ONE_NEAR);
        assert_eq!(staged.status, STAGED);

        // Next UTC day: full allowance is available again.
        let context = VMContextBuilder::new()
            .predecessor_account_id("agent-1.near".parse().unwrap())
            .block_timestamp(NANOS_PER_DAY)
            .build();
        testing_env!(context);
        set_predecessor_view_day_one(&mut guard);
    }

    fn set_predecessor_view_day_one(guard: &mut Guard) {
        let view = guard
            .get_agent("agent-1.near".parse().unwrap())
            .expect("agent must be registered");
        assert_eq!(view.remaining_today_yocto, U128::from(5 * ONE_NEAR));

        let outcome = guard.request_payment(
            "payee.near".parse().unwrap(),
            U128::from(5 * ONE_NEAR),
            "ref-2".to_string(),
            "Vendor".to_string(),
        );
        assert_eq!(outcome.status, STAGED);
    }

    // ---- issue #4 acceptance vectors: agent cap 10N, allowance 50N,
    // allowlist [good.near], ref invoice-114 cap 30N ----

    const FIVE_NEAR: u128 = 5 * ONE_NEAR;

    fn issue4_guard() -> Guard {
        let mut guard = fresh_guard();
        guard.register_agent(
            "agent.near".parse().unwrap(),
            U128::from(50 * ONE_NEAR),
            U128::from(10 * ONE_NEAR),
            vec!["good.near".parse().unwrap()],
        );
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            U128::from(30 * ONE_NEAR),
        );
        guard
    }

    fn request_for(
        guard: &mut Guard,
        caller: &str,
        payee: &str,
        amount: u128,
        purpose_ref: &str,
    ) -> PaymentOutcome {
        let context = VMContextBuilder::new()
            .predecessor_account_id(caller.parse().unwrap())
            .build();
        testing_env!(context);
        guard.request_payment(
            payee.parse().unwrap(),
            U128::from(amount),
            purpose_ref.to_string(),
            "CoreWeave".to_string(),
        )
    }

    #[test]
    fn wire_strings_match_acceptance_contract() {
        assert_eq!(REJECTED, "rejected");
        assert_eq!(REASON_EXCEEDS_PER_PAYMENT_CAP, "ExceedsPerPaymentCap");
        assert_eq!(REASON_PAYEE_NOT_ALLOWLISTED, "PayeeNotAllowlisted");
        assert!(
            REASON_PURPOSE_REF_NOT_FOUND.contains("PurposeRef"),
            "unknown-ref reason must contain PurposeRef"
        );
    }

    #[test]
    fn non_allowlisted_payee_yields_payee_not_allowlisted() {
        let mut guard = issue4_guard();
        let outcome = request_for(
            &mut guard,
            "agent.near",
            "evil.near",
            FIVE_NEAR,
            "invoice-114",
        );
        assert_eq!(outcome.request_id, 1);
        assert_eq!(outcome.status, "rejected");
        assert_eq!(
            outcome.reason,
            Some(REASON_PAYEE_NOT_ALLOWLISTED.to_string())
        );

        let stored = guard
            .get_request(outcome.request_id)
            .expect("rejection must be recorded");
        assert_eq!(stored.status, "rejected");
        assert_eq!(
            stored.reason,
            Some(REASON_PAYEE_NOT_ALLOWLISTED.to_string())
        );
        assert_eq!(stored.payee.as_str(), "evil.near");

        // Rejections consume no allowance.
        let view = guard
            .get_agent("agent.near".parse().unwrap())
            .expect("agent must be registered");
        assert_eq!(view.remaining_today_yocto, U128::from(50 * ONE_NEAR));
    }

    #[test]
    fn amount_above_cap_yields_exceeds_per_payment_cap() {
        let mut guard = issue4_guard();
        // 400N exceeds the 10N cap, the 50N allowance, and the 30N ref cap:
        // the cap check fires first.
        let outcome = request_for(
            &mut guard,
            "agent.near",
            "good.near",
            400 * ONE_NEAR,
            "invoice-114",
        );
        assert_eq!(outcome.status, "rejected");
        assert_eq!(
            outcome.reason,
            Some(REASON_EXCEEDS_PER_PAYMENT_CAP.to_string())
        );

        let stored = guard
            .get_request(outcome.request_id)
            .expect("rejection must be recorded");
        assert_eq!(stored.status, "rejected");
        assert_eq!(
            stored.reason,
            Some(REASON_EXCEEDS_PER_PAYMENT_CAP.to_string())
        );
    }

    #[test]
    fn unknown_ref_yields_purpose_ref_reason_and_is_stored() {
        let mut guard = issue4_guard();
        let outcome = request_for(&mut guard, "agent.near", "good.near", FIVE_NEAR, "nope-999");
        assert_eq!(outcome.status, "rejected");
        let reason = outcome.reason.clone().expect("reason must be set");
        assert!(
            reason.contains("PurposeRef"),
            "unknown-ref reason must contain PurposeRef, got {reason}"
        );

        let stored = guard
            .get_request(outcome.request_id)
            .expect("rejection must be stored retrievable by get_request");
        assert_eq!(stored.status, "rejected");
        assert!(
            stored
                .reason
                .as_deref()
                .unwrap_or("")
                .contains("PurposeRef"),
            "stored reason must contain PurposeRef"
        );
    }

    #[test]
    fn clean_request_stages_and_draws_allowance_until_exhausted() {
        let mut guard = issue4_guard();

        let clean = request_for(
            &mut guard,
            "agent.near",
            "good.near",
            FIVE_NEAR,
            "invoice-114",
        );
        assert_eq!(clean.request_id, 1);
        assert_eq!(clean.status, STAGED);
        assert_eq!(clean.reason, None);

        // Cap-boundary amounts stage: four more 10N requests fill the 50N
        // allowance exactly (5 + 4*10 = 45... plus one 5N top-up = 50).
        for _ in 0..4 {
            let outcome = request_for(
                &mut guard,
                "agent.near",
                "good.near",
                10 * ONE_NEAR,
                "invoice-114",
            );
            assert_eq!(outcome.status, STAGED);
        }
        let top_up = request_for(
            &mut guard,
            "agent.near",
            "good.near",
            FIVE_NEAR,
            "invoice-114",
        );
        assert_eq!(top_up.status, STAGED);

        // Allowance exhausted: the next yocto-scale request breaches the day.
        let breached = request_for(
            &mut guard,
            "agent.near",
            "good.near",
            FIVE_NEAR,
            "invoice-114",
        );
        assert_eq!(breached.status, REJECTED);
        assert_eq!(
            breached.reason,
            Some(REASON_EXCEEDS_DAILY_ALLOWANCE.to_string())
        );
        let stored = guard
            .get_request(breached.request_id)
            .expect("rejection must be recorded");
        assert_eq!(stored.status, REJECTED);
    }

    #[test]
    fn closed_ref_yields_purpose_ref_closed() {
        let mut guard = issue4_guard();
        set_predecessor(OWNER);
        guard.close_purpose_ref("invoice-114".to_string());

        let outcome = request_for(
            &mut guard,
            "agent.near",
            "good.near",
            FIVE_NEAR,
            "invoice-114",
        );
        assert_eq!(outcome.status, REJECTED);
        assert_eq!(outcome.reason, Some(REASON_PURPOSE_REF_CLOSED.to_string()));
        let stored = guard
            .get_request(outcome.request_id)
            .expect("rejection must be recorded");
        assert_eq!(stored.status, REJECTED);
    }

    #[test]
    fn amount_above_ref_cap_yields_exceeds_purpose_ref_cap() {
        let mut guard = fresh_guard();
        guard.register_agent(
            "big.near".parse().unwrap(),
            U128::from(200 * ONE_NEAR),
            U128::from(100 * ONE_NEAR),
            vec!["good.near".parse().unwrap()],
        );
        guard.register_purpose_ref(
            "small-ref".to_string(),
            "Vendor".to_string(),
            U128::from(30 * ONE_NEAR),
        );

        // 50N fits the agent cap and allowance but exceeds the 30N ref cap.
        let outcome = request_for(
            &mut guard,
            "big.near",
            "good.near",
            50 * ONE_NEAR,
            "small-ref",
        );
        assert_eq!(outcome.status, REJECTED);
        assert_eq!(
            outcome.reason,
            Some(REASON_EXCEEDS_PURPOSE_REF_CAP.to_string())
        );
    }

    #[test]
    fn mixed_outcome_ids_are_monotonic_from_one() {
        let mut guard = issue4_guard();

        let evil = request_for(
            &mut guard,
            "agent.near",
            "evil.near",
            FIVE_NEAR,
            "invoice-114",
        );
        assert_eq!(evil.request_id, 1);
        assert_eq!(evil.status, REJECTED);

        let over_cap = request_for(
            &mut guard,
            "agent.near",
            "good.near",
            400 * ONE_NEAR,
            "invoice-114",
        );
        assert_eq!(over_cap.request_id, 2);
        assert_eq!(over_cap.status, REJECTED);

        let unknown = request_for(&mut guard, "agent.near", "good.near", FIVE_NEAR, "nope-999");
        assert_eq!(unknown.request_id, 3);
        assert_eq!(unknown.status, REJECTED);

        let clean = request_for(
            &mut guard,
            "agent.near",
            "good.near",
            FIVE_NEAR,
            "invoice-114",
        );
        assert_eq!(clean.request_id, 4);
        assert_eq!(clean.status, STAGED);
    }

    #[test]
    fn list_requests_returns_three_sequential_ids_starting_at_one() {
        let mut guard = issue4_guard();
        for _ in 0..3 {
            let outcome = request_for(
                &mut guard,
                "agent.near",
                "good.near",
                FIVE_NEAR,
                "invoice-114",
            );
            assert_eq!(outcome.status, STAGED);
        }
        let listed = guard.list_requests(0, 10);
        assert_eq!(listed.len(), 3);
        let ids: Vec<u64> = listed.iter().map(|r| r.request_id).collect();
        assert_eq!(ids, vec![1, 2, 3]);
    }

    #[test]
    fn list_requests_pagination_slices() {
        let mut guard = issue4_guard();
        for _ in 0..3 {
            let outcome = request_for(
                &mut guard,
                "agent.near",
                "good.near",
                FIVE_NEAR,
                "invoice-114",
            );
            assert_eq!(outcome.status, STAGED);
        }
        let page = guard.list_requests(1, 1);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].request_id, 2);
        let empty = guard.list_requests(10, 10);
        assert!(empty.is_empty());
        let none = guard.list_requests(0, 0);
        assert!(none.is_empty());
    }
}
