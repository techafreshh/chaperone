use near_sdk::json_types::U128;
use near_sdk::near;

/// On-chain record of a real invoice/order an agent may pay (contract storage).
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PurposeRef {
    pub vendor: String,
    pub max_amount_yocto: U128,
    pub open: bool,
}

/// Public read view of a purpose ref, with the ref id attached.
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PurposeRefView {
    pub ref_id: String,
    pub vendor: String,
    pub max_amount_yocto: U128,
    pub open: bool,
}

impl PurposeRefView {
    pub fn new(ref_id: String, r: &PurposeRef) -> Self {
        Self {
            ref_id,
            vendor: r.vendor.clone(),
            max_amount_yocto: r.max_amount_yocto,
            open: r.open,
        }
    }
}

pub(crate) fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

pub(crate) fn log_purpose_ref_registered(ref_id: &str, vendor: &str, max_amount_yocto: U128) {
    near_sdk::env::log_str(&format!(
        "{{\"standard\":\"chaperone\",\"version\":\"1.0.0\",\"event\":\"purpose_ref_registered\",\"data\":{{\"ref_id\":\"{}\",\"vendor\":\"{}\",\"max_amount_yocto\":\"{}\"}}}}",
        escape_json(ref_id),
        escape_json(vendor),
        max_amount_yocto.0
    ));
}

pub(crate) fn log_purpose_ref_closed(ref_id: &str) {
    near_sdk::env::log_str(&format!(
        "{{\"standard\":\"chaperone\",\"version\":\"1.0.0\",\"event\":\"purpose_ref_closed\",\"data\":{{\"ref_id\":\"{}\"}}}}",
        escape_json(ref_id)
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Guard;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use near_sdk::AccountId;

    const OWNER: &str = "owner.testnet";

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

    #[test]
    fn register_then_get_returns_vendor_and_open() {
        let mut guard = fresh_guard();
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
        );

        let view = guard
            .get_purpose_ref("invoice-114".to_string())
            .expect("ref must be registered");
        assert_eq!(view.ref_id, "invoice-114");
        assert_eq!(view.vendor, "CoreWeave");
        assert!(view.open);
        assert_eq!(
            view.max_amount_yocto.0.to_string(),
            "30000000000000000000000000"
        );
    }

    #[test]
    fn close_flips_open_to_false() {
        let mut guard = fresh_guard();
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
        );

        guard.close_purpose_ref("invoice-114".to_string());
        let view = guard
            .get_purpose_ref("invoice-114".to_string())
            .expect("ref must be registered");
        assert!(!view.open);
        assert_eq!(view.vendor, "CoreWeave");

        // Idempotent: closing again stays open:false without panicking.
        guard.close_purpose_ref("invoice-114".to_string());
        let view = guard
            .get_purpose_ref("invoice-114".to_string())
            .expect("ref must be registered");
        assert!(!view.open);
    }

    #[test]
    fn list_returns_both_refs() {
        let mut guard = fresh_guard();
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
        );
        guard.register_purpose_ref(
            "order-7".to_string(),
            "Lambda".to_string(),
            U128::from(1_000_000_000_000_000_000_000_000u128),
        );

        let refs = guard.list_purpose_refs();
        assert_eq!(refs.len(), 2);
        let ids: Vec<String> = refs.iter().map(|r| r.ref_id.clone()).collect();
        assert!(ids.contains(&"invoice-114".to_string()));
        assert!(ids.contains(&"order-7".to_string()));
    }

    #[test]
    #[should_panic(expected = "Purpose ref already registered")]
    fn duplicate_register_panics() {
        let mut guard = fresh_guard();
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
        );
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
        );
    }

    #[test]
    #[should_panic(expected = "Purpose ref not registered")]
    fn unknown_close_panics() {
        let mut guard = fresh_guard();
        guard.close_purpose_ref("ghost-ref".to_string());
    }

    #[test]
    fn non_owner_writes_panic() {
        let mut guard = fresh_guard();
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
        );

        set_predecessor("mallory.near");
        let register = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.register_purpose_ref(
                "invoice-999".to_string(),
                "Evil".to_string(),
                U128::from(1u128),
            );
        }));
        assert!(register.is_err(), "non-owner register_purpose_ref must panic");

        let close = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.close_purpose_ref("invoice-114".to_string());
        }));
        assert!(close.is_err(), "non-owner close_purpose_ref must panic");
    }

    #[test]
    fn views_readable_by_non_owner_and_unknown_returns_none() {
        let mut guard = fresh_guard();
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
        );

        set_predecessor("anyone.near");
        let view = guard
            .get_purpose_ref("invoice-114".to_string())
            .expect("views must be public");
        assert!(view.open);
        assert_eq!(guard.list_purpose_refs().len(), 1);
        assert!(guard.get_purpose_ref("ghost-ref".to_string()).is_none());
    }
}
