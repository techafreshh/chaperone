use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::AccountId;

use crate::books::escape_json;

/// Stored status for a payment request that passed the active and
/// allowance gates.
pub(crate) const STAGED: &str = "staged";
/// Stored status for a payment request rejected at intake.
pub(crate) const REJECTED: &str = "rejected";
/// Rejection reason for requests from a deactivated agent.
pub(crate) const REASON_AGENT_INACTIVE: &str = "AgentInactive";
/// Rejection reason for requests that would exceed the daily allowance.
pub(crate) const REASON_EXCEEDS_DAILY_ALLOWANCE: &str = "ExceedsDailyAllowance";

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

pub(crate) fn log_request_created(request: &PaymentRequest) {
    near_sdk::env::log_str(&format!(
        "{{\"standard\":\"chaperone\",\"version\":\"1.0.0\",\"event\":\"request_created\",\"data\":{{\"request_id\":{},\"agent_id\":\"{}\",\"payee\":\"{}\",\"amount_yocto\":\"{}\",\"purpose_ref\":\"{}\",\"vendor\":\"{}\"}}}}",
        request.request_id,
        escape_json(request.agent_id.as_str()),
        escape_json(request.payee.as_str()),
        request.amount_yocto.0,
        escape_json(&request.purpose_ref),
        escape_json(&request.vendor)
    ));
}

pub(crate) fn log_request_rejected(request: &PaymentRequest) {
    let reason = request.reason.as_deref().unwrap_or("");
    near_sdk::env::log_str(&format!(
        "{{\"standard\":\"chaperone\",\"version\":\"1.0.0\",\"event\":\"request_rejected\",\"data\":{{\"request_id\":{},\"agent_id\":\"{}\",\"reason\":\"{}\"}}}}",
        request.request_id,
        escape_json(request.agent_id.as_str()),
        escape_json(reason)
    ));
}

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
            vec![],
        );
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
        assert_eq!(outcome.request_id, 0);
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
    fn request_ids_are_monotonic_from_zero() {
        let mut guard = fresh_guard();
        register(&mut guard, "agent-1.near", 10 * ONE_NEAR);
        register(&mut guard, "agent-2.near", 10 * ONE_NEAR);

        set_predecessor(OWNER);
        guard.set_agent_active("agent-1.near".parse().unwrap(), false);

        // Rejection still allocates an id.
        let rejected = request_as(&mut guard, "agent-1.near", "payee.near", ONE_NEAR);
        assert_eq!(rejected.request_id, 0);

        let first = request_as(&mut guard, "agent-2.near", "payee.near", ONE_NEAR);
        assert_eq!(first.request_id, 1);

        let second = request_as(&mut guard, "agent-2.near", "payee.near", ONE_NEAR);
        assert_eq!(second.request_id, 2);

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
}
