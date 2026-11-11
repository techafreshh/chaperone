use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::AccountId;

/// On-chain record of a real invoice/order an agent may pay (contract storage).
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PurposeRef {
    pub vendor: String,
    pub payee: AccountId,
    pub max_amount_yocto: U128,
    /// What the invoice or order is for (up to 280 UTF-8 bytes).
    pub description: String,
    pub committed_yocto: U128,
    pub paid_yocto: U128,
    pub open: bool,
}

impl PurposeRef {
    /// Amount still available on the ref: max minus everything staged,
    /// held, paying (`committed`) or settled (`paid`). Saturates so a
    /// legacy or rounding breach never underflows.
    pub fn remaining_yocto(&self) -> u128 {
        self.max_amount_yocto
            .0
            .saturating_sub(self.committed_yocto.0)
            .saturating_sub(self.paid_yocto.0)
    }
}

/// Public read view of a purpose ref, with the ref id attached.
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PurposeRefView {
    pub ref_id: String,
    pub vendor: String,
    pub payee: AccountId,
    pub max_amount_yocto: U128,
    pub committed_yocto: U128,
    pub paid_yocto: U128,
    pub remaining_yocto: U128,
    pub description: String,
    pub open: bool,
}

impl PurposeRefView {
    pub fn new(ref_id: String, r: &PurposeRef) -> Self {
        let remaining = r.remaining_yocto();
        Self {
            ref_id,
            vendor: r.vendor.clone(),
            payee: r.payee.clone(),
            max_amount_yocto: r.max_amount_yocto,
            committed_yocto: r.committed_yocto,
            paid_yocto: r.paid_yocto,
            remaining_yocto: U128::from(remaining),
            description: r.description.clone(),
            open: r.open,
        }
    }
}

#[allow(unused_imports)]
pub(crate) use crate::events::{
    escape_json, log_purpose_ref_closed, log_purpose_ref_registered,
};

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
            "payee.near".parse().unwrap(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
            "Test invoice description".to_string(),
        );

        let view = guard
            .get_purpose_ref("invoice-114".to_string())
            .expect("ref must be registered");
        assert_eq!(view.ref_id, "invoice-114");
        assert_eq!(view.vendor, "CoreWeave");
        assert_eq!(view.payee.as_str(), "payee.near");
        assert!(view.open);
        assert_eq!(
            view.max_amount_yocto.0.to_string(),
            "30000000000000000000000000"
        );
        assert_eq!(view.committed_yocto, U128::from(0));
        assert_eq!(view.paid_yocto, U128::from(0));
        assert_eq!(view.remaining_yocto, view.max_amount_yocto);
    }

    #[test]
    fn close_flips_open_to_false() {
        let mut guard = fresh_guard();
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            "payee.near".parse().unwrap(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
            "Test invoice description".to_string(),
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
            "payee.near".parse().unwrap(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
            "Test invoice description".to_string(),
        );
        guard.register_purpose_ref(
            "order-7".to_string(),
            "Lambda".to_string(),
            "other.near".parse().unwrap(),
            U128::from(1_000_000_000_000_000_000_000_000u128),
            "Test invoice description".to_string(),
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
            "payee.near".parse().unwrap(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
            "Test invoice description".to_string(),
        );
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            "payee.near".parse().unwrap(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
            "Test invoice description".to_string(),
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
            "payee.near".parse().unwrap(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
            "Test invoice description".to_string(),
        );

        set_predecessor("mallory.near");
        let register = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.register_purpose_ref(
                "invoice-999".to_string(),
                "Evil".to_string(),
                "evil.near".parse().unwrap(),
                U128::from(1u128),
                "Test invoice description".to_string(),
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
            "payee.near".parse().unwrap(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
            "Test invoice description".to_string(),
        );

        set_predecessor("anyone.near");
        let view = guard
            .get_purpose_ref("invoice-114".to_string())
            .expect("views must be public");
        assert!(view.open);
        assert_eq!(guard.list_purpose_refs().len(), 1);
        assert!(guard.get_purpose_ref("ghost-ref".to_string()).is_none());
    }

    #[test]
    fn description_is_stored_and_returned() {
        let mut guard = fresh_guard();
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            "payee.near".parse().unwrap(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
            "GPU hours, October 2026".to_string(),
        );
        let view = guard
            .get_purpose_ref("invoice-114".to_string())
            .expect("views must be public");
        assert_eq!(view.description, "GPU hours, October 2026".to_string());
    }

    #[test]
    #[should_panic(expected = "Invalid description")]
    fn overlong_description_panics() {
        let mut guard = fresh_guard();
        guard.register_purpose_ref(
            "invoice-114".to_string(),
            "CoreWeave".to_string(),
            "payee.near".parse().unwrap(),
            U128::from(30_000_000_000_000_000_000_000_000u128),
            "x".repeat(281),
        );
    }
}
