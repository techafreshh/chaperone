use crate::request::PaymentRequest;

/// Domain separator prefixing every signed verdict payload (PRD §10.1).
pub(crate) const VERDICT_DOMAIN: &str = "chaperone-verdict-v1";

/// Canonical verdict payload the verifier signs (PRD §10.1, byte-stable):
/// `domain || le_u64(id) || agent || payee || le_u128(amount) || ref || byte`
/// with `verdict_byte` 1 for consistent, 0 for inconsistent.
pub(crate) fn canonical_verdict_payload(
    request: &PaymentRequest,
    consistent: bool,
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(
        VERDICT_DOMAIN.len() + 8 + request.agent_id.as_str().len() + request.payee.as_str().len()
            + 16
            + request.purpose_ref.len()
            + 1,
    );
    payload.extend_from_slice(VERDICT_DOMAIN.as_bytes());
    payload.extend_from_slice(&request.request_id.to_le_bytes());
    payload.extend_from_slice(request.agent_id.as_str().as_bytes());
    payload.extend_from_slice(request.payee.as_str().as_bytes());
    payload.extend_from_slice(&request.amount_yocto.0.to_le_bytes());
    payload.extend_from_slice(request.purpose_ref.as_bytes());
    payload.push(if consistent { 1u8 } else { 0u8 });
    payload
}

/// Base58-decodes a registered verifier key; panics unless it is 32 bytes.
pub(crate) fn decode_verifier_key(public_key_base58: &str) -> [u8; 32] {
    let decoded = bs58::decode(public_key_base58)
        .into_vec()
        .expect("Invalid verifier public key");
    decoded
        .try_into()
        .expect("Invalid verifier public key")
}

/// Base58-decodes a submitted verdict signature; panics unless 64 bytes.
pub(crate) fn decode_signature(signature_base58: &str) -> [u8; 64] {
    let decoded = bs58::decode(signature_base58)
        .into_vec()
        .expect("Invalid verdict signature");
    decoded.try_into().expect("Invalid verdict signature")
}

pub(crate) use crate::events::{
    log_request_held, log_request_paid, log_verdict_recorded, log_verifier_set,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Guard;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use near_sdk::{AccountId, NearToken};

    const OWNER: &str = "owner.testnet";
    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    // Fixed signing fixture so the byte-stability vectors below are
    // reproducible without randomness.
    const SECRET_BYTES: [u8; 32] = [7u8; 32];
    const OTHER_SECRET_BYTES: [u8; 32] = [9u8; 32];

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

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&SECRET_BYTES)
    }

    fn other_signing_key() -> SigningKey {
        SigningKey::from_bytes(&OTHER_SECRET_BYTES)
    }

    fn key_base58(key: &SigningKey) -> String {
        bs58::encode(key.verifying_key().to_bytes()).into_string()
    }

    fn fund_treasury(guard: &mut Guard, amount_yocto: u128) {
        let context = VMContextBuilder::new()
            .predecessor_account_id(OWNER.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(amount_yocto))
            .build();
        testing_env!(context);
        guard.deposit_fleet_funds();
    }

    /// Stages three clean requests (ids 1, 2, 3) mirroring the issue's
    /// known agent/payee/amount/ref shape, with the verifier registered
    /// and 100 NEAR in the logical treasury so consistent verdicts pay.
    fn staged_guard() -> (Guard, SigningKey) {
        let mut guard = fresh_guard();
        let key = signing_key();
        guard.register_agent(
            "agent.near".parse().unwrap(),
            U128::from(50 * ONE_NEAR),
            U128::from(50 * ONE_NEAR),
            vec!["payee.near".parse().unwrap()],
        );
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            "payee.near".parse().unwrap(),
            U128::from(50 * ONE_NEAR),
        );
        guard.set_verifier(Some(key_base58(&key)));
        fund_treasury(&mut guard, 100 * ONE_NEAR);
        for _ in 0..3 {
            set_predecessor("agent.near");
            let outcome = guard.request_payment(
                "payee.near".parse().unwrap(),
                U128::from(5 * ONE_NEAR),
                "invoice-114".to_string(),
                "CoreWeave".to_string(),
            );
            assert_eq!(outcome.status, "staged");
        }
        (guard, key)
    }

    fn sign_as(key: &SigningKey, guard: &Guard, request_id: u64, consistent: bool) -> String {
        let request = guard
            .get_request(request_id)
            .expect("request must exist");
        let payload = canonical_verdict_payload(&request, consistent);
        bs58::encode(key.sign(&payload).to_bytes()).into_string()
    }

    #[test]
    fn canonical_payload_is_byte_stable() {
        let request = PaymentRequest {
            request_id: 1,
            agent_id: "agent.near".parse().unwrap(),
            payee: "payee.near".parse().unwrap(),
            amount_yocto: U128::from(5 * ONE_NEAR),
            purpose_ref: "invoice-114".to_string(),
            vendor: "CoreWeave".to_string(),
            status: "staged".to_string(),
            reason: None,
        };
        let payload = canonical_verdict_payload(&request, true);

        let mut expected = Vec::new();
        expected.extend_from_slice(b"chaperone-verdict-v1");
        expected.extend_from_slice(&1u64.to_le_bytes());
        expected.extend_from_slice(b"agent.near");
        expected.extend_from_slice(b"payee.near");
        expected.extend_from_slice(&(5 * ONE_NEAR).to_le_bytes());
        expected.extend_from_slice(b"invoice-114");
        expected.push(1u8);

        assert_eq!(payload, expected);
        assert_eq!(payload.len(), 20 + 8 + 10 + 10 + 16 + 11 + 1);
        // Domain separator leads; id follows it; verdict byte trails.
        assert_eq!(&payload[..20], b"chaperone-verdict-v1");
        assert_eq!(&payload[20..28], &1u64.to_le_bytes());
        assert_eq!(payload[payload.len() - 1], 1u8);
    }

    #[test]
    fn verdict_byte_differs_by_consistency_only() {
        let (guard, _) = staged_guard();
        let request = guard.get_request(1).expect("request must exist");
        let yes = canonical_verdict_payload(&request, true);
        let no = canonical_verdict_payload(&request, false);
        assert_eq!(yes.len(), no.len());
        assert_eq!(&yes[..yes.len() - 1], &no[..no.len() - 1]);
        assert_eq!(yes[yes.len() - 1], 1u8);
        assert_eq!(no[no.len() - 1], 0u8);
    }

    #[test]
    #[should_panic(expected = "Invalid verifier public key")]
    fn decode_verifier_key_rejects_short_bytes() {
        decode_verifier_key(&bs58::encode([1u8; 16]).into_string());
    }

    #[test]
    #[should_panic(expected = "Invalid verifier public key")]
    fn decode_verifier_key_rejects_bad_base58() {
        decode_verifier_key("not-base58!!!");
    }

    #[test]
    #[should_panic(expected = "Invalid verdict signature")]
    fn decode_signature_rejects_short_bytes() {
        decode_signature(&bs58::encode([1u8; 32]).into_string());
    }

    #[test]
    fn set_verifier_round_trip_rotate_and_clear() {
        let mut guard = fresh_guard();
        assert_eq!(guard.get_verifier(), None);

        let key = signing_key();
        set_predecessor(OWNER);
        guard.set_verifier(Some(key_base58(&key)));
        assert_eq!(guard.get_verifier(), Some(key_base58(&key)));

        // Rotation replaces the stored key.
        let other = other_signing_key();
        guard.set_verifier(Some(key_base58(&other)));
        assert_eq!(guard.get_verifier(), Some(key_base58(&other)));

        // Clearing removes it.
        guard.set_verifier(None);
        assert_eq!(guard.get_verifier(), None);
    }

    #[test]
    fn non_owner_set_verifier_panics() {
        let mut guard = fresh_guard();
        let key = signing_key();
        set_predecessor("mallory.near");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.set_verifier(Some(key_base58(&key)));
        }));
        assert!(result.is_err(), "non-owner set_verifier must panic");
    }

    #[test]
    fn submit_consistent_verdict_starts_payout_for_request_two() {
        let (mut guard, key) = staged_guard();
        set_predecessor("anyone.near");
        let sig = sign_as(&key, &guard, 2, true);
        guard.submit_verdict(2, true, sig);
        // Funded: `staged -> paying`, treasury debited at once; the
        // private `on_payout` callback settles `paid` later.
        let stored = guard.get_request(2).expect("request must exist");
        assert_eq!(stored.status, "paying");
        assert_eq!(stored.reason, None);
        assert_eq!(
            guard.treasury(),
            U128::from(100 * ONE_NEAR - 5 * ONE_NEAR)
        );
        // In-flight payouts never join the approval queue.
        assert!(guard.list_queue().is_empty());
        assert_eq!(guard.fleet_summary().pending_queue, 0);
    }

    #[test]
    fn settle_success_marks_paid_and_keeps_treasury_debited() {
        let (mut guard, key) = staged_guard();
        set_predecessor("anyone.near");
        let sig = sign_as(&key, &guard, 2, true);
        guard.submit_verdict(2, true, sig);
        guard.settle_payout(2, true);
        let stored = guard.get_request(2).expect("request must exist");
        assert_eq!(stored.status, "paid");
        assert_eq!(stored.reason, None);
        assert_eq!(
            guard.treasury(),
            U128::from(100 * ONE_NEAR - 5 * ONE_NEAR)
        );
        // The 15 NEAR drawn at intake stays drawn after success.
        let view = guard
            .get_agent("agent.near".parse().unwrap())
            .expect("agent must be registered");
        assert_eq!(view.spent_today_yocto, U128::from(15 * ONE_NEAR));
    }

    #[test]
    fn settle_failure_restores_treasury_and_spend() {
        let (mut guard, key) = staged_guard();
        set_predecessor("anyone.near");
        let sig = sign_as(&key, &guard, 2, true);
        guard.submit_verdict(2, true, sig);
        assert_eq!(
            guard.treasury(),
            U128::from(100 * ONE_NEAR - 5 * ONE_NEAR)
        );
        guard.settle_payout(2, false);
        let stored = guard.get_request(2).expect("request must exist");
        assert_eq!(stored.status, "failed");
        assert_eq!(stored.reason, Some("TransferFailed".to_string()));
        assert_eq!(guard.treasury(), U128::from(100 * ONE_NEAR));
        // The failed 5 NEAR is released: intake drew 15, one is back.
        let view = guard
            .get_agent("agent.near".parse().unwrap())
            .expect("agent must be registered");
        assert_eq!(view.spent_today_yocto, U128::from(10 * ONE_NEAR));
        assert!(guard.list_queue().is_empty());
        assert_eq!(guard.fleet_summary().pending_queue, 0);
    }

    // Note: the `#[private]` guard on `on_payout` is enforced by the
    // macro-generated WASM wrapper, so host unit tests cannot observe it
    // (direct Rust calls bypass the wrapper). The sandbox round trip
    // asserts it on-chain instead: a direct `on_payout` call fails with
    // "Method on_payout is private" instead of settling.
    #[test]
    #[should_panic(expected = "Request is not paying")]
    fn settle_non_paying_request_panics() {
        let (mut guard, _key) = staged_guard();
        set_predecessor("anyone.near");
        // Request 1 is still staged: only `paying` rows settle.
        guard.settle_payout(1, true);
    }

    #[test]
    fn consistent_verdict_without_funds_holds_with_insufficient_treasury() {
        let (mut guard, key) = staged_guard();
        set_predecessor(OWNER);
        let _ = guard.withdraw_fleet_funds(
            OWNER.parse().unwrap(),
            U128::from(100 * ONE_NEAR),
        );
        assert_eq!(guard.treasury(), U128::from(0));

        set_predecessor("anyone.near");
        let sig = sign_as(&key, &guard, 2, true);
        guard.submit_verdict(2, true, sig);
        let stored = guard.get_request(2).expect("request must exist");
        assert_eq!(stored.status, "held");
        assert_eq!(stored.reason, Some("InsufficientTreasury".to_string()));
        // Nothing moved: no debit, no spend release, still queued.
        assert_eq!(guard.treasury(), U128::from(0));
        assert_eq!(guard.list_queue().len(), 1);
        assert_eq!(guard.list_queue()[0].request_id, 2);
        assert_eq!(guard.fleet_summary().pending_queue, 1);
    }

    #[test]
    fn approve_hold_without_funds_panics_then_pays_after_top_up() {
        let (mut guard, key) = staged_guard();
        set_predecessor("anyone.near");
        guard.submit_verdict(3, false, sign_as(&key, &guard, 3, false));
        assert_eq!(
            guard.get_request(3).expect("request must exist").status,
            "held"
        );

        set_predecessor(OWNER);
        let _ = guard.withdraw_fleet_funds(
            OWNER.parse().unwrap(),
            U128::from(100 * ONE_NEAR),
        );
        let denied = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.approve_hold(3);
        }));
        match denied {
            Ok(()) => panic!("underfunded approve_hold must panic"),
            Err(payload) => {
                let msg = payload.downcast_ref::<String>().cloned().unwrap_or_default();
                assert!(
                    msg.contains("Insufficient treasury"),
                    "unexpected approve_hold panic: {msg}"
                );
            }
        }
        assert_eq!(
            guard.get_request(3).expect("request must exist").status,
            "held"
        );

        // Top up and approve: `held -> paying` with the treasury debited.
        fund_treasury(&mut guard, 5 * ONE_NEAR);
        guard.approve_hold(3);
        let stored = guard.get_request(3).expect("request must exist");
        assert_eq!(stored.status, "paying");
        assert_eq!(stored.reason, None);
        assert_eq!(guard.treasury(), U128::from(0));
        assert!(guard.list_queue().is_empty());
    }

    #[test]
    fn submit_inconsistent_verdict_holds_request_two_and_queues_it() {
        let (mut guard, key) = staged_guard();
        set_predecessor("anyone.near");
        let sig = sign_as(&key, &guard, 3, false);
        guard.submit_verdict(3, false, sig);

        let stored = guard.get_request(3).expect("request must exist");
        assert_eq!(stored.status, "held");

        let queue = guard.list_queue();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].request_id, 3);

        // Paid/staged requests never appear in the queue.
        let paid_sig = sign_as(&key, &guard, 2, true);
        guard.submit_verdict(2, true, paid_sig);
        let queue = guard.list_queue();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].request_id, 3);
        assert_eq!(guard.fleet_summary().pending_queue, 1);
    }

    #[test]
    fn permissionless_submit_with_valid_sig_succeeds() {
        let (mut guard, key) = staged_guard();
        // A non-owner, non-agent caller posts the verdict.
        set_predecessor("stranger.near");
        let sig = sign_as(&key, &guard, 1, true);
        guard.submit_verdict(1, true, sig);
        assert_eq!(
            guard.get_request(1).expect("request must exist").status,
            "paying"
        );
    }

    #[test]
    fn wrong_key_signature_fails_and_hold_remains() {
        let (mut guard, key) = staged_guard();
        set_predecessor("anyone.near");
        let hold_sig = sign_as(&key, &guard, 3, false);
        guard.submit_verdict(3, false, hold_sig);
        assert_eq!(
            guard.get_request(3).expect("request must exist").status,
            "held"
        );

        // Signature from an unregistered key over the same payload.
        let bad_sig = sign_as(&other_signing_key(), &guard, 3, false);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.submit_verdict(3, false, bad_sig);
        }));
        assert!(result.is_err(), "wrong-key verdict must panic");
        assert_eq!(
            guard.get_request(3).expect("request must exist").status,
            "held"
        );
        assert_eq!(guard.list_queue().len(), 1);
    }

    #[test]
    #[should_panic(expected = "Invalid verdict signature")]
    fn tampered_amount_signature_fails() {
        let (mut guard, key) = staged_guard();
        // Sign a payload for a different amount than the stored request.
        let mut tampered = guard.get_request(2).expect("request must exist");
        tampered.amount_yocto = U128::from(6 * ONE_NEAR);
        let payload = canonical_verdict_payload(&tampered, true);
        let sig = bs58::encode(key.sign(&payload).to_bytes()).into_string();
        set_predecessor("anyone.near");
        guard.submit_verdict(2, true, sig);
    }

    #[test]
    #[should_panic(expected = "Verifier not registered")]
    fn submit_without_verifier_panics() {
        let mut guard = fresh_guard();
        guard.register_agent(
            "agent.near".parse().unwrap(),
            U128::from(50 * ONE_NEAR),
            U128::from(50 * ONE_NEAR),
            vec!["payee.near".parse().unwrap()],
        );
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            "payee.near".parse().unwrap(),
            U128::from(50 * ONE_NEAR),
        );
        set_predecessor("agent.near");
        guard.request_payment(
            "payee.near".parse().unwrap(),
            U128::from(ONE_NEAR),
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
        );
        set_predecessor("anyone.near");
        guard.submit_verdict(1, true, bs58::encode([1u8; 64]).into_string());
    }

    #[test]
    #[should_panic(expected = "Request is not staged")]
    fn double_verdict_on_terminal_state_panics() {
        let (mut guard, key) = staged_guard();
        set_predecessor("anyone.near");
        let sig = sign_as(&key, &guard, 2, true);
        guard.submit_verdict(2, true, sig.clone());
        // Second verdict on the now-paid request must fail.
        guard.submit_verdict(2, true, sig);
    }

    #[test]
    #[should_panic(expected = "Request not found")]
    fn submit_unknown_request_panics() {
        let (mut guard, key) = staged_guard();
        let _ = key;
        set_predecessor("anyone.near");
        guard.submit_verdict(99, true, bs58::encode([1u8; 64]).into_string());
    }

    #[test]
    fn staged_requests_do_not_inflate_pending_queue_until_held() {
        let (mut guard, key) = staged_guard();
        // Staged-only: three staged requests, nothing awaiting a decision.
        assert_eq!(guard.fleet_summary().pending_queue, 0);
        assert!(guard.list_queue().is_empty());
        let staged = guard.list_requests(0, 10);
        assert_eq!(staged.len(), 3);
        assert!(staged.iter().all(|record| record.status == "staged"));

        // One hold: only the held request counts toward pending.
        set_predecessor("anyone.near");
        guard.submit_verdict(1, false, sign_as(&key, &guard, 1, false));
        assert_eq!(guard.fleet_summary().pending_queue, 1);
        let queue = guard.list_queue();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].request_id, 1);
        assert_eq!(
            guard.fleet_summary().pending_queue,
            guard.list_queue().len() as u64
        );

        // A paying sibling stays out of the queue with the staged one.
        guard.submit_verdict(2, true, sign_as(&key, &guard, 2, true));
        assert_eq!(
            guard.get_request(2).expect("request must exist").status,
            "paying"
        );
        assert_eq!(
            guard.get_request(3).expect("request must exist").status,
            "staged"
        );
        assert_eq!(guard.fleet_summary().pending_queue, 1);
        assert_eq!(guard.list_queue()[0].request_id, 1);

        // A second hold raises pending to two; owner decisions drain it.
        guard.submit_verdict(3, false, sign_as(&key, &guard, 3, false));
        assert_eq!(guard.fleet_summary().pending_queue, 2);

        set_predecessor(OWNER);
        guard.approve_hold(1);
        assert_eq!(
            guard.get_request(1).expect("request must exist").status,
            "paying"
        );
        guard.reject_hold(3);
        assert_eq!(
            guard.get_request(3).expect("request must exist").status,
            "rejected"
        );
        assert!(guard.list_queue().is_empty());
        assert_eq!(guard.fleet_summary().pending_queue, 0);
    }

    #[test]
    fn approve_hold_starts_payout_and_reject_hold_releases_spend() {
        let (mut guard, key) = staged_guard();
        set_predecessor("anyone.near");
        guard.submit_verdict(2, false, sign_as(&key, &guard, 2, false));
        guard.submit_verdict(3, false, sign_as(&key, &guard, 3, false));
        assert_eq!(guard.list_queue().len(), 2);

        set_predecessor(OWNER);
        guard.approve_hold(2);
        let approved = guard.get_request(2).expect("request must exist");
        assert_eq!(approved.status, "paying");
        assert_eq!(approved.reason, None);
        assert_eq!(
            guard.treasury(),
            U128::from(100 * ONE_NEAR - 5 * ONE_NEAR)
        );

        guard.reject_hold(3);
        let rejected = guard.get_request(3).expect("request must exist");
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.reason, Some("HoldRejected".to_string()));
        // Intake drew 15 NEAR of allowance; the rejection releases 5.
        let view = guard
            .get_agent("agent.near".parse().unwrap())
            .expect("agent must be registered");
        assert_eq!(view.spent_today_yocto, U128::from(10 * ONE_NEAR));
        // Rejections never transfer: the treasury only lost the payout.
        assert_eq!(
            guard.treasury(),
            U128::from(100 * ONE_NEAR - 5 * ONE_NEAR)
        );

        // Both leave the queue; nothing remains pending.
        assert!(guard.list_queue().is_empty());
        assert_eq!(guard.fleet_summary().pending_queue, 0);
    }

    #[test]
    fn second_hold_decision_on_terminal_state_panics() {
        let (mut guard, key) = staged_guard();
        set_predecessor("anyone.near");
        guard.submit_verdict(2, false, sign_as(&key, &guard, 2, false));

        set_predecessor(OWNER);
        guard.approve_hold(2);
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.approve_hold(2);
        }));
        assert!(again.is_err(), "approve on paid request must panic");

        let reject_paid = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.reject_hold(2);
        }));
        assert!(reject_paid.is_err(), "reject on paid request must panic");
    }

    #[test]
    fn non_owner_hold_decisions_panic() {
        let (mut guard, key) = staged_guard();
        set_predecessor("anyone.near");
        guard.submit_verdict(2, false, sign_as(&key, &guard, 2, false));

        set_predecessor("mallory.near");
        let approve = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.approve_hold(2);
        }));
        assert!(approve.is_err(), "non-owner approve_hold must panic");
        let reject = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.reject_hold(2);
        }));
        assert!(reject.is_err(), "non-owner reject_hold must panic");
        // Hold survives both attempts.
        assert_eq!(
            guard.get_request(2).expect("request must exist").status,
            "held"
        );
    }
}
