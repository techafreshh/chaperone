use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::AccountId;

/// On-chain per-agent spending policy (contract storage).
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentPolicy {
    pub daily_allowance_yocto: U128,
    pub per_payment_cap_yocto: U128,
    pub payee_allowlist: Vec<AccountId>,
    pub active: bool,
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
}

impl AgentView {
    pub fn new(agent_id: AccountId, policy: &AgentPolicy) -> Self {
        Self {
            agent_id,
            daily_allowance_yocto: policy.daily_allowance_yocto,
            per_payment_cap_yocto: policy.per_payment_cap_yocto,
            payee_allowlist: policy.payee_allowlist.clone(),
            active: policy.active,
        }
    }
}
