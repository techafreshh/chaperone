use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::{NearToken, Promise};
// UnorderedMap is mandated by the issue contract (owner-gated registry
// with `list_agents`); the sdk deprecation in favour of IterableMap is
// acknowledged and intentionally not followed (no migration path needed
// pre-deploy, and the issue names UnorderedMap explicitly).
#[allow(deprecated)]
use near_sdk::store::UnorderedMap;
use near_sdk::{env, require, AccountId};

mod books;
mod policy;

use books::{log_purpose_ref_closed, log_purpose_ref_registered, PurposeRef, PurposeRefView};
use policy::{AgentPolicy, AgentView};

#[near(contract_state)]
pub struct Guard {
    owner: AccountId,
    #[allow(deprecated)]
    agents: UnorderedMap<AccountId, AgentPolicy>,
    #[allow(deprecated)]
    purpose_refs: UnorderedMap<String, PurposeRef>,
    treasury_yocto: u128,
}

/// Public read view of fleet funds: logical treasury balance, registered
/// agent count, and the payment-request queue depth (0 until `request_payment`
/// lands).
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FleetSummary {
    pub treasury_yocto: U128,
    pub agent_count: u64,
    pub pending_queue: u64,
}

#[near]
impl Guard {
    #[init]
    #[allow(deprecated)]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner: owner_id,
            agents: UnorderedMap::new(b"agents".as_slice()),
            purpose_refs: UnorderedMap::new(b"purpose_refs".as_slice()),
            treasury_yocto: 0,
        }
    }

    pub fn register_agent(
        &mut self,
        agent_id: AccountId,
        daily_allowance_yocto: U128,
        per_payment_cap_yocto: U128,
        payee_allowlist: Vec<AccountId>,
    ) {
        self.assert_owner();
        assert!(
            !self.agents.contains_key(&agent_id),
            "Agent already registered"
        );
        self.agents.insert(
            agent_id,
            AgentPolicy {
                daily_allowance_yocto,
                per_payment_cap_yocto,
                payee_allowlist,
                active: true,
            },
        );
    }

    pub fn set_agent_policy(
        &mut self,
        agent_id: AccountId,
        daily_allowance_yocto: Option<U128>,
        per_payment_cap_yocto: Option<U128>,
    ) {
        self.assert_owner();
        let mut policy = self
            .agents
            .get(&agent_id)
            .cloned()
            .expect("Agent not registered");
        if let Some(allowance) = daily_allowance_yocto {
            policy.daily_allowance_yocto = allowance;
        }
        if let Some(cap) = per_payment_cap_yocto {
            policy.per_payment_cap_yocto = cap;
        }
        self.agents.insert(agent_id, policy);
    }

    pub fn get_agent(&self, agent_id: AccountId) -> Option<AgentView> {
        self.agents
            .get(&agent_id)
            .map(|policy| AgentView::new(agent_id.clone(), policy))
    }

    pub fn list_agents(&self) -> Vec<AgentView> {
        let mut views: Vec<AgentView> = self
            .agents
            .iter()
            .map(|(agent_id, policy)| AgentView::new(agent_id.clone(), policy))
            .collect();
        views.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
        views
    }

    pub fn register_purpose_ref(
        &mut self,
        ref_id: String,
        vendor: String,
        max_amount_yocto: U128,
    ) {
        self.assert_owner();
        assert!(
            !self.purpose_refs.contains_key(&ref_id),
            "Purpose ref already registered"
        );
        self.purpose_refs.insert(
            ref_id.clone(),
            PurposeRef {
                vendor: vendor.clone(),
                max_amount_yocto,
                open: true,
            },
        );
        log_purpose_ref_registered(&ref_id, &vendor, max_amount_yocto);
    }

    pub fn close_purpose_ref(&mut self, ref_id: String) {
        self.assert_owner();
        let mut purpose_ref = self
            .purpose_refs
            .get(&ref_id)
            .cloned()
            .expect("Purpose ref not registered");
        purpose_ref.open = false;
        self.purpose_refs.insert(ref_id.clone(), purpose_ref);
        log_purpose_ref_closed(&ref_id);
    }

    pub fn get_purpose_ref(&self, ref_id: String) -> Option<PurposeRefView> {
        self.purpose_refs
            .get(&ref_id)
            .map(|purpose_ref| PurposeRefView::new(ref_id.clone(), purpose_ref))
    }

    pub fn list_purpose_refs(&self) -> Vec<PurposeRefView> {
        let mut views: Vec<PurposeRefView> = self
            .purpose_refs
            .iter()
            .map(|(ref_id, purpose_ref)| PurposeRefView::new(ref_id.clone(), purpose_ref))
            .collect();
        views.sort_by(|a, b| a.ref_id.cmp(&b.ref_id));
        views
    }

    /// Anyone may attach NEAR to fund the fleet treasury. The attached
    /// deposit is credited to the logical treasury balance.
    #[payable]
    pub fn deposit_fleet_funds(&mut self) {
        let amount = env::attached_deposit().as_yoctonear();
        self.treasury_yocto = self.treasury_yocto.saturating_add(amount);
        log_funds_deposited(&env::predecessor_account_id(), amount);
    }

    /// Owner-only withdrawal of treasury leftovers. State is decremented
    /// before the transfer promise is built; no callback reconciliation
    /// (deferred per the payment-request plan).
    pub fn withdraw_fleet_funds(&mut self, to: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(
            amount.0 <= self.treasury_yocto,
            "Insufficient treasury balance"
        );
        self.treasury_yocto -= amount.0;
        log_funds_withdrawn(&to, amount.0);
        Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Logical treasury balance (sum of `deposit_fleet_funds` minus
    /// `withdraw_fleet_funds`). Direct transfers bypassing
    /// `deposit_fleet_funds` do not credit it.
    pub fn treasury(&self) -> U128 {
        U128::from(self.treasury_yocto)
    }

    pub fn fleet_summary(&self) -> FleetSummary {
        FleetSummary {
            treasury_yocto: U128::from(self.treasury_yocto),
            agent_count: self.agents.len() as u64,
            pending_queue: 0,
        }
    }
}

fn log_funds_deposited(account: &AccountId, amount_yocto: u128) {
    env::log_str(&format!(
        "{{\"standard\":\"chaperone\",\"version\":\"1.0.0\",\"event\":\"funds_deposited\",\"data\":{{\"account\":\"{}\",\"amount_yocto\":\"{}\"}}}}",
        account.as_str(),
        amount_yocto
    ));
}

fn log_funds_withdrawn(to: &AccountId, amount_yocto: u128) {
    env::log_str(&format!(
        "{{\"standard\":\"chaperone\",\"version\":\"1.0.0\",\"event\":\"funds_withdrawn\",\"data\":{{\"to\":\"{}\",\"amount_yocto\":\"{}\"}}}}",
        to.as_str(),
        amount_yocto
    ));
}

impl Guard {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only contract owner may call this method"
        );
    }

    // Pure policy helper: a payment that keeps total spend within the
    // allowance is permitted. Kept free of `env` so unit tests run on
    // the host with no blockchain mock.
    pub fn within_allowance(spent: u128, allowance: u128) -> bool {
        spent <= allowance
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const OWNER: &str = "owner.testnet";
    const ALLOWANCE: u128 = 50_000_000_000_000_000_000_000_000;
    const CAP: u128 = 10_000_000_000_000_000_000_000_000;

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

    fn register_alice(guard: &mut Guard) {
        guard.register_agent(
            "alice.near".parse().unwrap(),
            U128::from(ALLOWANCE),
            U128::from(CAP),
            vec!["a.near".parse().unwrap()],
        );
    }

    #[test]
    fn allow_when_spent_within_allowance() {
        assert!(Guard::within_allowance(60, 100));
        assert!(Guard::within_allowance(100, 100));
        assert!(Guard::within_allowance(0, 0));
    }

    #[test]
    fn deny_when_spent_exceeds_allowance() {
        assert!(!Guard::within_allowance(101, 100));
        assert!(!Guard::within_allowance(1, 0));
    }

    #[test]
    fn register_returns_exact_policy_and_active() {
        let mut guard = fresh_guard();
        register_alice(&mut guard);

        let view = guard
            .get_agent("alice.near".parse().unwrap())
            .expect("agent must be registered");
        assert_eq!(view.agent_id.as_str(), "alice.near");
        assert_eq!(view.daily_allowance_yocto, U128::from(ALLOWANCE));
        assert_eq!(view.per_payment_cap_yocto, U128::from(CAP));
        assert_eq!(
            view.daily_allowance_yocto.0.to_string(),
            "50000000000000000000000000"
        );
        assert_eq!(
            view.per_payment_cap_yocto.0.to_string(),
            "10000000000000000000000000"
        );
        assert_eq!(
            view.payee_allowlist,
            vec!["a.near".parse::<AccountId>().unwrap()]
        );
        assert!(view.active);
    }

    #[test]
    fn policy_update_reflects_new_cap() {
        let mut guard = fresh_guard();
        register_alice(&mut guard);

        let new_cap: u128 = 1_000_000_000_000_000_000_000_000;
        guard.set_agent_policy(
            "alice.near".parse().unwrap(),
            None,
            Some(U128::from(new_cap)),
        );

        let view = guard
            .get_agent("alice.near".parse().unwrap())
            .expect("agent must be registered");
        assert_eq!(view.per_payment_cap_yocto, U128::from(new_cap));
        assert_eq!(view.daily_allowance_yocto, U128::from(ALLOWANCE));
    }

    #[test]
    fn list_returns_both_agents() {
        let mut guard = fresh_guard();
        register_alice(&mut guard);
        guard.register_agent(
            "bob.near".parse().unwrap(),
            U128::from(ALLOWANCE),
            U128::from(CAP),
            vec![],
        );

        let agents = guard.list_agents();
        assert_eq!(agents.len(), 2);
        let ids: Vec<String> = agents.iter().map(|a| a.agent_id.to_string()).collect();
        assert!(ids.contains(&"alice.near".to_string()));
        assert!(ids.contains(&"bob.near".to_string()));
    }

    #[test]
    fn non_owner_write_panics() {
        let mut guard = fresh_guard();
        register_alice(&mut guard);

        set_predecessor("mallory.near");
        let register = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.register_agent(
                "mallory.near".parse().unwrap(),
                U128::from(ALLOWANCE),
                U128::from(CAP),
                vec![],
            );
        }));
        assert!(register.is_err(), "non-owner register_agent must panic");

        let tune = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guard.set_agent_policy("alice.near".parse().unwrap(), None, Some(U128::from(1)));
        }));
        assert!(tune.is_err(), "non-owner set_agent_policy must panic");
    }

    #[test]
    #[should_panic(expected = "Agent already registered")]
    fn duplicate_register_panics() {
        let mut guard = fresh_guard();
        register_alice(&mut guard);
        register_alice(&mut guard);
    }

    #[test]
    #[should_panic(expected = "Agent not registered")]
    fn unknown_agent_policy_panics() {
        let mut guard = fresh_guard();
        guard.set_agent_policy(
            "ghost.near".parse().unwrap(),
            Some(U128::from(ALLOWANCE)),
            None,
        );
    }

    #[test]
    fn views_readable_by_non_owner() {
        let mut guard = fresh_guard();
        register_alice(&mut guard);

        set_predecessor("anyone.near");
        let view = guard
            .get_agent("alice.near".parse().unwrap())
            .expect("views must be public");
        assert!(view.active);
        assert_eq!(guard.list_agents().len(), 1);
        assert!(guard.get_agent("ghost.near".parse().unwrap()).is_none());
    }

    fn deposit_as(account_id: &str, amount_yocto: u128) {
        let context = VMContextBuilder::new()
            .predecessor_account_id(account_id.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(amount_yocto))
            .build();
        testing_env!(context);
    }

    const FIVE_NEAR: u128 = 5_000_000_000_000_000_000_000_000;
    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    #[test]
    fn deposit_five_near_credits_treasury() {
        let mut guard = fresh_guard();
        deposit_as("anyone.near", FIVE_NEAR);
        guard.deposit_fleet_funds();
        assert_eq!(guard.treasury(), U128::from(FIVE_NEAR));
        assert_eq!(
            guard.treasury().0.to_string(),
            "5000000000000000000000000"
        );
    }

    #[test]
    fn owner_withdraw_decreases_treasury_by_exact_amount() {
        let mut guard = fresh_guard();
        deposit_as("anyone.near", FIVE_NEAR);
        guard.deposit_fleet_funds();

        set_predecessor(OWNER);
        let _ = guard.withdraw_fleet_funds("owner.testnet".parse().unwrap(), U128::from(ONE_NEAR));
        assert_eq!(guard.treasury(), U128::from(FIVE_NEAR - ONE_NEAR));
    }

    #[test]
    fn fleet_summary_reports_treasury_agents_and_empty_queue() {
        let mut guard = fresh_guard();
        register_alice(&mut guard);
        guard.register_agent(
            "bob.near".parse().unwrap(),
            U128::from(ALLOWANCE),
            U128::from(CAP),
            vec![],
        );
        deposit_as("anyone.near", FIVE_NEAR);
        guard.deposit_fleet_funds();

        set_predecessor("anyone.near");
        let summary = guard.fleet_summary();
        assert_eq!(summary.treasury_yocto, U128::from(FIVE_NEAR));
        assert_eq!(summary.agent_count, 2);
        assert_eq!(summary.pending_queue, 0);
    }

    #[test]
    fn non_owner_withdraw_panics() {
        let mut guard = fresh_guard();
        deposit_as("anyone.near", FIVE_NEAR);
        guard.deposit_fleet_funds();

        set_predecessor("mallory.near");
        let withdraw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = guard.withdraw_fleet_funds("mallory.near".parse().unwrap(), U128::from(ONE_NEAR));
        }));
        assert!(withdraw.is_err(), "non-owner withdraw_fleet_funds must panic");
    }

    #[test]
    #[should_panic(expected = "Insufficient treasury balance")]
    fn over_withdraw_panics() {
        let mut guard = fresh_guard();
        deposit_as("anyone.near", FIVE_NEAR);
        guard.deposit_fleet_funds();

        set_predecessor(OWNER);
        let _ = guard.withdraw_fleet_funds(
            "owner.testnet".parse().unwrap(),
            U128::from(FIVE_NEAR + ONE_NEAR),
        );
    }

    #[test]
    fn deposit_and_views_readable_by_non_owner() {
        let mut guard = fresh_guard();

        deposit_as("anyone.near", FIVE_NEAR);
        guard.deposit_fleet_funds();
        assert_eq!(guard.treasury().0.to_string(), "5000000000000000000000000");
        let summary = guard.fleet_summary();
        assert_eq!(summary.agent_count, 0);
        assert_eq!(summary.pending_queue, 0);
    }
}
