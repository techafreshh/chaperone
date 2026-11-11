use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::AccountId;


/// Nanoseconds in one UTC day.
pub(crate) const NANOS_PER_DAY: u64 = 86_400_000_000_000;

/// On-chain per-agent spending policy (contract storage).
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentPolicy {
    pub daily_allowance_yocto: U128,
    pub per_payment_cap_yocto: U128,
    pub payee_allowlist: Vec<AccountId>,
    pub active: bool,
    pub spent_today_yocto: U128,
    pub last_spend_day: u64,
}

/// Public read view of an agent's policy, with the agent id attached.
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentView {
    pub agent_id: AccountId,
    pub daily_allowance_yocto: U128,
    pub per_payment_cap_yocto: U128,
    pub payee_allowlist: Vec<AccountId>,
    pub active: bool,
    pub spent_today_yocto: U128,
    pub remaining_today_yocto: U128,
}

impl AgentView {
    pub fn new(agent_id: AccountId, policy: &AgentPolicy) -> Self {
        let spent = effective_spent(policy);
        let remaining = policy.daily_allowance_yocto.0.saturating_sub(spent);
        Self {
            agent_id,
            daily_allowance_yocto: policy.daily_allowance_yocto,
            per_payment_cap_yocto: policy.per_payment_cap_yocto,
            payee_allowlist: policy.payee_allowlist.clone(),
            active: policy.active,
            spent_today_yocto: U128::from(spent),
            remaining_today_yocto: U128::from(remaining),
        }
    }
}

/// Pure UTC-day index for a block timestamp in nanoseconds.
pub(crate) fn day_for_timestamp(ns: u64) -> u64 {
    ns / NANOS_PER_DAY
}

/// Current UTC-day index from the block timestamp.
pub(crate) fn current_utc_day() -> u64 {
    day_for_timestamp(near_sdk::env::block_timestamp())
}

/// Spend that counts against today's allowance: zero when the stored
/// day is stale (a UTC midnight passed without a mutation).
pub(crate) fn effective_spent(policy: &AgentPolicy) -> u128 {
    if policy.last_spend_day == current_utc_day() {
        policy.spent_today_yocto.0
    } else {
        0
    }
}

/// Zero the daily spend and stamp the current day when stale. No-op
/// when the stored day is already today.
pub(crate) fn refresh_day(policy: &mut AgentPolicy) {
    if policy.last_spend_day != current_utc_day() {
        policy.spent_today_yocto = U128::from(0);
        policy.last_spend_day = current_utc_day();
    }
}

pub(crate) use crate::events::{log_agent_killed, log_agent_reenabled, log_payees_updated};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Guard;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

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
    fn day_for_timestamp_boundaries() {
        assert_eq!(day_for_timestamp(0), 0);
        assert_eq!(day_for_timestamp(NANOS_PER_DAY - 1), 0);
        assert_eq!(day_for_timestamp(NANOS_PER_DAY), 1);
        assert_eq!(day_for_timestamp(2 * NANOS_PER_DAY), 2);
    }

    #[test]
    fn view_shows_full_allowance_after_utc_midnight() {
        let mut guard = fresh_guard();
        guard.register_agent(
            "agent-1.near".parse().unwrap(),
            U128::from(10u128),
            U128::from(10u128),
            vec!["payee.near".parse().unwrap()],
        );
        guard.register_purpose_ref(
            "ref-1".to_string(),
            "Vendor".to_string(),
            "payee.near".parse().unwrap(),
            U128::from(10u128),
            "Test invoice description".to_string(),
        );

        // Spend 5 on day 0.
        let context = VMContextBuilder::new()
            .predecessor_account_id("agent-1.near".parse().unwrap())
            .build();
        testing_env!(context);
        let outcome = guard.request_payment(
            "payee.near".parse().unwrap(),
            U128::from(5u128),
            "ref-1".to_string(),
            "Vendor".to_string(),
            "Test payment memo".to_string(),
        );
        assert_eq!(outcome.status, "staged");

        // Advance past UTC midnight: remaining resets to the full allowance.
        let context = VMContextBuilder::new()
            .predecessor_account_id("anyone.near".parse().unwrap())
            .block_timestamp(NANOS_PER_DAY)
            .build();
        testing_env!(context);
        let view = guard
            .get_agent("agent-1.near".parse().unwrap())
            .expect("agent must be registered");
        assert_eq!(view.spent_today_yocto, U128::from(0));
        assert_eq!(view.remaining_today_yocto, U128::from(10u128));
    }

    #[test]
    fn refresh_day_zeroes_stale_spend() {
        set_predecessor(OWNER);
        let mut policy = AgentPolicy {
            daily_allowance_yocto: U128::from(10u128),
            per_payment_cap_yocto: U128::from(10u128),
            payee_allowlist: vec![],
            active: true,
            spent_today_yocto: U128::from(7u128),
            last_spend_day: 0,
        };
        // testing_env from set_predecessor leaves block_timestamp at 0 (day 0).
        refresh_day(&mut policy);
        assert_eq!(policy.spent_today_yocto, U128::from(7u128));
        assert_eq!(policy.last_spend_day, 0);

        // Move to day 1: refresh zeroes spend and stamps the new day.
        let context = VMContextBuilder::new()
            .predecessor_account_id(OWNER.parse().unwrap())
            .block_timestamp(NANOS_PER_DAY)
            .build();
        testing_env!(context);
        refresh_day(&mut policy);
        assert_eq!(policy.spent_today_yocto, U128::from(0));
        assert_eq!(policy.last_spend_day, 1);
        assert_eq!(effective_spent(&policy), 0);
    }

    #[test]
    fn kill_then_reenable_round_trip() {
        let mut guard = fresh_guard();
        guard.register_agent(
            "agent-1.near".parse().unwrap(),
            U128::from(10u128),
            U128::from(10u128),
            vec![],
        );

        guard.set_agent_active("agent-1.near".parse().unwrap(), false);
        let view = guard
            .get_agent("agent-1.near".parse().unwrap())
            .expect("agent must be registered");
        assert!(!view.active);

        guard.set_agent_active("agent-1.near".parse().unwrap(), true);
        let view = guard
            .get_agent("agent-1.near".parse().unwrap())
            .expect("agent must be registered");
        assert!(view.active);
    }

    #[test]
    fn payee_add_is_idempotent_and_remove_is_selective() {
        let mut guard = fresh_guard();
        guard.register_agent(
            "agent-1.near".parse().unwrap(),
            U128::from(10u128),
            U128::from(10u128),
            vec!["a.near".parse().unwrap()],
        );

        guard.add_payees(
            "agent-1.near".parse().unwrap(),
            vec!["a.near".parse().unwrap(), "b.near".parse().unwrap()],
        );
        let view = guard
            .get_agent("agent-1.near".parse().unwrap())
            .expect("agent must be registered");
        assert_eq!(view.payee_allowlist.len(), 2);

        guard.remove_payees(
            "agent-1.near".parse().unwrap(),
            vec!["a.near".parse().unwrap()],
        );
        let view = guard
            .get_agent("agent-1.near".parse().unwrap())
            .expect("agent must be registered");
        assert_eq!(
            view.payee_allowlist,
            vec!["b.near".parse::<AccountId>().unwrap()]
        );
    }

    #[test]
    #[should_panic(expected = "Agent not registered")]
    fn set_active_unknown_agent_panics() {
        let mut guard = fresh_guard();
        guard.set_agent_active("ghost.near".parse().unwrap(), false);
    }

    #[test]
    #[should_panic(expected = "Agent not registered")]
    fn add_payees_unknown_agent_panics() {
        let mut guard = fresh_guard();
        guard.add_payees("ghost.near".parse().unwrap(), vec![]);
    }

    #[test]
    #[should_panic(expected = "Agent not registered")]
    fn remove_payees_unknown_agent_panics() {
        let mut guard = fresh_guard();
        guard.remove_payees("ghost.near".parse().unwrap(), vec![]);
    }

    #[test]
    fn non_owner_policy_writes_panic() {
        let mut guard = fresh_guard();
        guard.register_agent(
            "agent-1.near".parse().unwrap(),
            U128::from(10u128),
            U128::from(10u128),
            vec![],
        );

        set_predecessor("mallory.near");
        let kill = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.set_agent_active("agent-1.near".parse().unwrap(), false);
        }));
        assert!(kill.is_err(), "non-owner set_agent_active must panic");

        let add = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.add_payees("agent-1.near".parse().unwrap(), vec![]);
        }));
        assert!(add.is_err(), "non-owner add_payees must panic");

        let remove = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.remove_payees("agent-1.near".parse().unwrap(), vec![]);
        }));
        assert!(remove.is_err(), "non-owner remove_payees must panic");
    }
}
