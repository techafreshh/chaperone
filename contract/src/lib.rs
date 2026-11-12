use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::{Gas, NearToken, Promise};
// UnorderedMap is mandated by the issue contract (owner-gated registry
// with `list_agents`); the sdk deprecation in favour of IterableMap is
// acknowledged and intentionally not followed (no migration path needed
// pre-deploy, and the issue names UnorderedMap explicitly).
#[allow(deprecated)]
use near_sdk::store::UnorderedMap;
use near_sdk::{env, require, AccountId};

mod books;
mod events;
mod policy;
mod request;
mod verifier;

use books::{log_purpose_ref_closed, log_purpose_ref_registered, PurposeRef, PurposeRefView};
use events::{log_agent_registered, log_funds_deposited, log_funds_withdraw_failed, log_funds_withdrawn, log_policy_updated};
use policy::{
    current_utc_day, effective_spent, log_agent_killed, log_agent_reenabled, log_payees_updated,
    refresh_day, AgentPolicy, AgentView,
};
use request::{
    log_request_created, log_request_failed, log_request_rejected, PaymentOutcome, PaymentRequest,
    FAILED, HELD, PAID, PAYING, REASON_AGENT_INACTIVE, REASON_EXCEEDS_DAILY_ALLOWANCE,
    REASON_EXCEEDS_PER_PAYMENT_CAP, REASON_EXCEEDS_PURPOSE_REF_REMAINING, REASON_HOLD_REJECTED,
    REASON_INSUFFICIENT_TREASURY, REASON_INVALID_MEMO, REASON_PAYEE_NOT_ALLOWLISTED,
    REASON_PURPOSE_REF_CLOSED, REASON_PURPOSE_REF_NOT_FOUND, REASON_PURPOSE_REF_PAYEE_MISMATCH,
    REASON_PURPOSE_REF_VENDOR_MISMATCH, REASON_TRANSFER_FAILED, REJECTED, STAGED,
};
use verifier::{
    canonical_verdict_payload, decode_evidence_sha256, decode_signature, decode_verifier_key,
    log_request_held, log_request_paid, log_verdict_recorded, log_verifier_set,
};

#[near(contract_state)]
pub struct Guard {
    owner: AccountId,
    #[allow(deprecated)]
    agents: UnorderedMap<AccountId, AgentPolicy>,
    #[allow(deprecated)]
    purpose_refs: UnorderedMap<String, PurposeRef>,
    #[allow(deprecated)]
    requests: UnorderedMap<u64, PaymentRequest>,
    request_seq: u64,
    treasury_yocto: u128,
    verifier_key: Option<Vec<u8>>,
}

/// Public read view of fleet funds: logical treasury balance, registered
/// agent count, and the approval-queue depth (held requests awaiting a
/// human decision). The depth counts held requests only and always equals
/// `list_queue` length; staged (awaiting verifier), paid, and rejected
/// requests are excluded.
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
            requests: UnorderedMap::new(b"requests".as_slice()),
            request_seq: 1,
            treasury_yocto: 0,
            verifier_key: None,
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
            agent_id.clone(),
            AgentPolicy {
                daily_allowance_yocto,
                per_payment_cap_yocto,
                payee_allowlist: payee_allowlist.clone(),
                active: true,
                spent_today_yocto: U128::from(0),
                last_spend_day: current_utc_day(),
            },
        );
        log_agent_registered(
            &agent_id,
            daily_allowance_yocto,
            per_payment_cap_yocto,
            &payee_allowlist,
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
        self.agents.insert(agent_id.clone(), policy.clone());
        log_policy_updated(
            &agent_id,
            policy.daily_allowance_yocto,
            policy.per_payment_cap_yocto,
        );
    }

    pub fn set_agent_active(&mut self, agent_id: AccountId, active: bool) {
        self.assert_owner();
        let mut policy = self
            .agents
            .get(&agent_id)
            .cloned()
            .expect("Agent not registered");
        policy.active = active;
        self.agents.insert(agent_id.clone(), policy);
        if active {
            log_agent_reenabled(&agent_id);
        } else {
            log_agent_killed(&agent_id);
        }
    }

    pub fn add_payees(&mut self, agent_id: AccountId, payees: Vec<AccountId>) {
        self.assert_owner();
        let mut policy = self
            .agents
            .get(&agent_id)
            .cloned()
            .expect("Agent not registered");
        for payee in payees {
            if !policy.payee_allowlist.contains(&payee) {
                policy.payee_allowlist.push(payee);
            }
        }
        log_payees_updated(&agent_id, &policy.payee_allowlist);
        self.agents.insert(agent_id, policy);
    }

    pub fn remove_payees(&mut self, agent_id: AccountId, payees: Vec<AccountId>) {
        self.assert_owner();
        let mut policy = self
            .agents
            .get(&agent_id)
            .cloned()
            .expect("Agent not registered");
        policy.payee_allowlist.retain(|p| !payees.contains(p));
        log_payees_updated(&agent_id, &policy.payee_allowlist);
        self.agents.insert(agent_id, policy);
    }

    /// Owner-only registration (or rotation) of the Ed25519 verifier key
    /// that authorizes verdicts. `Some` base58-decodes to 32 bytes and
    /// stores; `None` clears the key. Emits `verifier_set`.
    pub fn set_verifier(&mut self, public_key_base58: Option<String>) {
        self.assert_owner();
        match public_key_base58.as_deref() {
            Some(key) => {
                let decoded = decode_verifier_key(key);
                self.verifier_key = Some(decoded.to_vec());
                log_verifier_set(Some(key));
            }
            None => {
                self.verifier_key = None;
                log_verifier_set(None);
            }
        }
    }

    /// Permissionless view of the registered verifier key (base58).
    pub fn get_verifier(&self) -> Option<String> {
        self.verifier_key
            .as_deref()
            .map(|key| bs58::encode(key).into_string())
    }

    /// Agent intake for a payment: the stated `memo` (1..=280 UTF-8 bytes,
    /// panics with `"Invalid memo"` otherwise) is stored and emitted before
    /// any other check. Deterministic on-chain checks then run in a
    /// fixed order (active → per-payment cap → daily allowance → payee
    /// allowlist → ref exists → ref open → ref payee → ref vendor → ref
    /// remaining) before any judgment step. Failures are
    /// rejected-and-recorded with a machine-readable reason; only clean
    /// requests commit their amount to the ref, draw down the day's
    /// allowance, and stage. Every call consumes one `request_seq` id,
    /// starting at 1.
    /// Unknown callers panic with `"Agent not registered"`.
    pub fn request_payment(
        &mut self,
        payee: AccountId,
        amount_yocto: U128,
        purpose_ref: String,
        vendor: String,
        memo: String,
    ) -> PaymentOutcome {
        require!(
            !memo.is_empty() && memo.as_bytes().len() <= 280,
            REASON_INVALID_MEMO
        );
        let agent_id = env::predecessor_account_id();
        let mut policy = self
            .agents
            .get(&agent_id)
            .cloned()
            .expect("Agent not registered");
        refresh_day(&mut policy);

        if !policy.active {
            return self.reject(
                agent_id,
                policy,
                payee,
                amount_yocto,
                purpose_ref,
                vendor,
                memo.clone(),
                REASON_AGENT_INACTIVE,
            );
        }

        if !Guard::within_allowance(amount_yocto.0, policy.per_payment_cap_yocto.0) {
            return self.reject(
                agent_id,
                policy,
                payee,
                amount_yocto,
                purpose_ref,
                vendor,
                memo.clone(),
                REASON_EXCEEDS_PER_PAYMENT_CAP,
            );
        }

        let spent = effective_spent(&policy);
        if !Guard::within_allowance(
            spent.saturating_add(amount_yocto.0),
            policy.daily_allowance_yocto.0,
        ) {
            return self.reject(
                agent_id,
                policy,
                payee,
                amount_yocto,
                purpose_ref,
                vendor,
                memo.clone(),
                REASON_EXCEEDS_DAILY_ALLOWANCE,
            );
        }

        if !policy.payee_allowlist.contains(&payee) {
            return self.reject(
                agent_id,
                policy,
                payee,
                amount_yocto,
                purpose_ref,
                vendor,
                memo.clone(),
                REASON_PAYEE_NOT_ALLOWLISTED,
            );
        }

        let remaining = match self.purpose_refs.get(&purpose_ref).cloned() {
            None => {
                return self.reject(
                    agent_id,
                    policy,
                    payee,
                    amount_yocto,
                    purpose_ref,
                    vendor,
                    memo.clone(),
                    REASON_PURPOSE_REF_NOT_FOUND,
                );
            }
            Some(purpose_ref_record) => {
                if !purpose_ref_record.open {
                    return self.reject(
                        agent_id,
                        policy,
                        payee,
                        amount_yocto,
                        purpose_ref,
                        vendor,
                        memo.clone(),
                        REASON_PURPOSE_REF_CLOSED,
                    );
                }
                if payee != purpose_ref_record.payee {
                    return self.reject(
                        agent_id,
                        policy,
                        payee,
                        amount_yocto,
                        purpose_ref,
                        vendor,
                        memo.clone(),
                        REASON_PURPOSE_REF_PAYEE_MISMATCH,
                    );
                }
                if vendor != purpose_ref_record.vendor {
                    return self.reject(
                        agent_id,
                        policy,
                        payee,
                        amount_yocto,
                        purpose_ref,
                        vendor,
                        memo.clone(),
                        REASON_PURPOSE_REF_VENDOR_MISMATCH,
                    );
                }
                let remaining = purpose_ref_record.remaining_yocto();
                if amount_yocto.0 > remaining {
                    return self.reject(
                        agent_id,
                        policy,
                        payee,
                        amount_yocto,
                        purpose_ref,
                        vendor,
                        memo.clone(),
                        REASON_EXCEEDS_PURPOSE_REF_REMAINING,
                    );
                }
                remaining
            }
        };
        let _ = remaining;
        // Commit the amount to the ref before staging so double-spends
        // against `remaining_yocto` fail deterministically.
        self.commit_ref_amount(&purpose_ref, amount_yocto.0);
        policy.spent_today_yocto = U128::from(spent.saturating_add(amount_yocto.0));
        policy.last_spend_day = current_utc_day();
        self.agents.insert(agent_id.clone(), policy);
        let request_id = self.request_seq;
        self.request_seq += 1;
        let record = PaymentRequest {
            request_id,
            agent_id,
            payee,
            amount_yocto,
            purpose_ref,
            vendor,
            memo,
            status: STAGED.to_string(),
            reason: None,
        };
        self.requests.insert(request_id, record.clone());
        log_request_created(&record);
        PaymentOutcome {
            request_id,
            status: STAGED.to_string(),
            reason: None,
        }
    }

    /// Permissionless verdict intake: anyone may submit, but only a verdict
    /// carrying a valid Ed25519 signature from the registered verifier key
    /// over the v2 canonical payload (PRD §10.1: contract-id, request,
    /// memo hash and evidence hash bound) moves a staged request — to
    /// `paying` when consistent (the private `on_payout` callback settles
    /// `paying -> paid | failed`), unless the logical treasury does not
    /// cover the amount — then the request waits in the queue as `held`
    /// with reason `InsufficientTreasury`. An inconsistent verdict holds
    /// the request as before. Emits `verdict_recorded` plus `request_held`
    /// on the hold paths; `paid` and `failed` outcomes are emitted by the
    /// settlement callback.
    pub fn submit_verdict(
        &mut self,
        request_id: u64,
        consistent: bool,
        evidence_sha256: String,
        signature_base58: String,
    ) {
        let mut record = self
            .requests
            .get(&request_id)
            .cloned()
            .expect("Request not found");
        require!(record.status == STAGED, "Request is not staged");
        let key = self.verifier_key.clone().expect("Verifier not registered");
        let evidence = decode_evidence_sha256(&evidence_sha256);
        let signature = decode_signature(&signature_base58);
        let payload = canonical_verdict_payload(
            &record,
            &env::current_account_id(),
            &evidence,
            consistent,
        );
        let key_bytes: [u8; 32] = key.try_into().expect("Invalid verifier public key");
        require!(
            env::ed25519_verify(&signature, &payload, &key_bytes),
            "Invalid verdict signature"
        );
        if consistent {
            if record.amount_yocto.0 > self.treasury_yocto {
                record.status = HELD.to_string();
                record.reason = Some(REASON_INSUFFICIENT_TREASURY.to_string());
                self.requests.insert(request_id, record.clone());
                log_verdict_recorded(request_id, true);
                log_request_held(&record);
            } else {
                log_verdict_recorded(request_id, true);
                // Fire-and-forget: the transfer + callback receipts
                // execute whether or not the handle is returned.
                let _payout = self.begin_payout(&mut record);
                self.requests.insert(request_id, record.clone());
            }
        } else {
            record.status = HELD.to_string();
            self.requests.insert(request_id, record.clone());
            log_verdict_recorded(request_id, false);
            log_request_held(&record);
        }
    }

    /// Owner-only release of a held request: starts a real transfer
    /// (`held -> paying`; the private `on_payout` callback settles
    /// `paying -> paid | failed`) and clears the reason. Panics with
    /// `Insufficient treasury` when the logical treasury does not cover
    /// the amount, leaving the request `held`. Emits `request_paid` on
    /// success via the settlement callback.
    pub fn approve_hold(&mut self, request_id: u64) {
        self.assert_owner();
        let mut record = self
            .requests
            .get(&request_id)
            .cloned()
            .expect("Request not found");
        require!(record.status == HELD, "Request is not held");
        require!(
            record.amount_yocto.0 <= self.treasury_yocto,
            "Insufficient treasury"
        );
        // Fire-and-forget: the transfer + callback receipts execute
        // whether or not the handle is returned.
        let _payout = self.begin_payout(&mut record);
        self.requests.insert(request_id, record.clone());
    }

    /// Owner-only rejection of a held request: records it as rejected with
    /// reason `HoldRejected`, releases the ref commitment and the amount
    /// from the agent's same-day spend (rejections never transfer).
    /// Emits `request_rejected`.
    pub fn reject_hold(&mut self, request_id: u64) {
        self.assert_owner();
        let mut record = self
            .requests
            .get(&request_id)
            .cloned()
            .expect("Request not found");
        require!(record.status == HELD, "Request is not held");
        record.status = REJECTED.to_string();
        record.reason = Some(REASON_HOLD_REJECTED.to_string());
        self.requests.insert(request_id, record.clone());
        self.release_ref_amount(&record.purpose_ref, record.amount_yocto.0);
        self.release_spend(&record.agent_id, record.amount_yocto.0);
        log_request_rejected(&record);
    }

    /// Debit the treasury, mark the request `paying`, and schedule the
    /// transfer plus the private `on_payout` settlement callback. Callers
    /// must have checked treasury coverage first; the debit saturates so
    /// an (unreachable) shortfall can never underflow. The promise is
    /// fire-and-forget: receipts scheduled during execution run whether
    /// or not the caller returns the handle.
    fn begin_payout(&mut self, record: &mut PaymentRequest) -> Promise {
        let amount = record.amount_yocto.0;
        self.treasury_yocto = self.treasury_yocto.saturating_sub(amount);
        record.status = PAYING.to_string();
        record.reason = None;
        Promise::new(record.payee.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_payout".to_string(),
                    format!("{{\"request_id\":{}}}", record.request_id).into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(10),
                ),
            )
    }

    /// Private settlement callback for a `paying` transfer: the transfer
    /// receipt is promise 0. Success marks the request `paid` and emits
    /// `request_paid`; failure restores the treasury debit and the
    /// agent's same-day spend, marks the request `failed` with reason
    /// `TransferFailed`, and emits `request_failed`.
    #[private]
    pub fn on_payout(&mut self, request_id: u64) {
        // Bounded read: a transfer receipt succeeds with empty data, so
        // `max_len` 0 accepts exactly that and rejects anything longer.
        let succeeded = env::promise_result_checked(0, 0).is_ok();
        self.settle_payout(request_id, succeeded);
    }

    /// Shared settlement core so unit tests can cover both branches
    /// without executing promises (the host mock cannot produce a
    /// transfer result; the balance assertions belong in the sandbox
    /// round trip instead). Success moves the amount from committed to
    /// paid and auto-closes the ref (emitting `purpose_ref_closed`) when
    /// `paid` reaches the max; failure releases the ref commitment.
    fn settle_payout(&mut self, request_id: u64, succeeded: bool) {
        let mut record = self
            .requests
            .get(&request_id)
            .cloned()
            .expect("Request not found");
        require!(record.status == PAYING, "Request is not paying");
        let amount = record.amount_yocto.0;
        if succeeded {
            record.status = PAID.to_string();
            record.reason = None;
            self.requests.insert(request_id, record.clone());
            self.mark_ref_paid(&record.purpose_ref, amount);
            log_request_paid(&record);
        } else {
            record.status = FAILED.to_string();
            record.reason = Some(REASON_TRANSFER_FAILED.to_string());
            self.requests.insert(request_id, record.clone());
            self.treasury_yocto = self.treasury_yocto.saturating_add(amount);
            self.release_ref_amount(&record.purpose_ref, amount);
            self.release_spend(&record.agent_id, amount);
            log_request_failed(&record);
        }
    }

    /// Commit helper: stage-time reservation against the ref's remaining.
    /// Saturates so an (unreachable) over-commit never underflows; intake
    /// already proved `amount <= remaining`.
    fn commit_ref_amount(&mut self, ref_id: &str, amount: u128) {
        if let Some(mut purpose_ref) = self.purpose_refs.get(&ref_id.to_string()).cloned() {
            purpose_ref.committed_yocto =
                U128::from(purpose_ref.committed_yocto.0.saturating_add(amount));
            self.purpose_refs.insert(ref_id.to_string(), purpose_ref);
        }
    }

    /// Release helper: unwind a stage-time reservation (rejected hold or
    /// failed transfer). Saturates; missing refs (unreachable via intake)
    /// are ignored.
    fn release_ref_amount(&mut self, ref_id: &str, amount: u128) {
        if let Some(mut purpose_ref) = self.purpose_refs.get(&ref_id.to_string()).cloned() {
            purpose_ref.committed_yocto =
                U128::from(purpose_ref.committed_yocto.0.saturating_sub(amount));
            self.purpose_refs.insert(ref_id.to_string(), purpose_ref);
        }
    }

    /// Paid helper: move the amount from committed to paid; when `paid`
    /// reaches the max the ref closes itself and emits
    /// `purpose_ref_closed`. Saturates defensively.
    fn mark_ref_paid(&mut self, ref_id: &str, amount: u128) {
        if let Some(mut purpose_ref) = self.purpose_refs.get(&ref_id.to_string()).cloned() {
            purpose_ref.committed_yocto =
                U128::from(purpose_ref.committed_yocto.0.saturating_sub(amount));
            purpose_ref.paid_yocto =
                U128::from(purpose_ref.paid_yocto.0.saturating_add(amount));
            if purpose_ref.open && purpose_ref.paid_yocto.0 >= purpose_ref.max_amount_yocto.0 {
                purpose_ref.open = false;
                self.purpose_refs.insert(ref_id.to_string(), purpose_ref);
                log_purpose_ref_closed(ref_id);
            } else {
                self.purpose_refs.insert(ref_id.to_string(), purpose_ref);
            }
        }
    }

    /// Give the amount back to the agent's same-day spend. Stale days are
    /// left alone: past UTC midnight the effective spend is already zero,
    /// so touching the stored counters would corrupt the new day.
    fn release_spend(&mut self, agent_id: &AccountId, amount: u128) {
        if let Some(mut policy) = self.agents.get(agent_id).cloned() {
            if policy.last_spend_day == current_utc_day() {
                policy.spent_today_yocto =
                    U128::from(policy.spent_today_yocto.0.saturating_sub(amount));
                self.agents.insert(agent_id.clone(), policy);
            }
        }
    }

    pub fn get_request(&self, request_id: u64) -> Option<PaymentRequest> {
        self.requests.get(&request_id).cloned()
    }

    /// Reject-and-record helper: stores a `rejected` request under the next
    /// `request_seq` id (starting at 1), emits `request_rejected`, and leaves day-spend
    /// untouched. Persists the (possibly day-refreshed) policy.
    /// The wide signature mirrors the `PaymentRequest` fields so each
    /// check site stays a one-line call.
    #[allow(clippy::too_many_arguments)]
    fn reject(
        &mut self,
        agent_id: AccountId,
        policy: AgentPolicy,
        payee: AccountId,
        amount_yocto: U128,
        purpose_ref: String,
        vendor: String,
        memo: String,
        reason: &str,
    ) -> PaymentOutcome {
        let request_id = self.request_seq;
        self.request_seq += 1;
        let record = PaymentRequest {
            request_id,
            agent_id: agent_id.clone(),
            payee,
            amount_yocto,
            purpose_ref,
            vendor,
            memo,
            status: REJECTED.to_string(),
            reason: Some(reason.to_string()),
        };
        self.agents.insert(agent_id, policy);
        self.requests.insert(request_id, record.clone());
        log_request_rejected(&record);
        PaymentOutcome {
            request_id,
            status: REJECTED.to_string(),
            reason: Some(reason.to_string()),
        }
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

    /// Permissionless view of the approval queue: held requests only,
    /// ascending by id.
    pub fn list_queue(&self) -> Vec<PaymentRequest> {
        let mut queue: Vec<PaymentRequest> = self
            .requests
            .iter()
            .filter(|(_, record)| record.status == HELD)
            .map(|(_, record)| record.clone())
            .collect();
        queue.sort_by_key(|record| record.request_id);
        queue
    }

    /// Permissionless paginated view of all requests, ascending by id.
    /// Request ids start at 1. Out-of-range offsets return empty.
    pub fn list_requests(&self, offset: u64, limit: u64) -> Vec<PaymentRequest> {
        let mut all: Vec<PaymentRequest> = self
            .requests
            .iter()
            .map(|(_, record)| record.clone())
            .collect();
        all.sort_by_key(|record| record.request_id);
        all.into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    }

    pub fn register_purpose_ref(
        &mut self,
        ref_id: String,
        vendor: String,
        payee: AccountId,
        max_amount_yocto: U128,
        description: String,
    ) {
        self.assert_owner();
        require!(
            description.as_bytes().len() <= 280,
            "Invalid description"
        );
        assert!(
            !self.purpose_refs.contains_key(&ref_id),
            "Purpose ref already registered"
        );
        self.purpose_refs.insert(
            ref_id.clone(),
            PurposeRef {
                vendor: vendor.clone(),
                payee: payee.clone(),
                max_amount_yocto,
                description: description.clone(),
                committed_yocto: U128::from(0),
                paid_yocto: U128::from(0),
                open: true,
            },
        );
        log_purpose_ref_registered(&ref_id, &vendor, &payee, max_amount_yocto, &description);
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

    /// Owner-only withdrawal of treasury leftovers. The amount is
    /// debited before the transfer promise is built (reserving it
    /// against concurrent withdraws), then the transfer plus the
    /// private `on_withdraw` settlement callback is scheduled. Success
    /// emits `funds_withdrawn`; failure refunds the debit and emits
    /// `funds_withdraw_failed`.
    pub fn withdraw_fleet_funds(&mut self, to: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(
            amount.0 <= self.treasury_yocto,
            "Insufficient treasury balance"
        );
        self.treasury_yocto = self.treasury_yocto.saturating_sub(amount.0);
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_withdraw".to_string(),
                    format!("{{\"to\":\"{}\",\"amount\":\"{}\"}}", to.as_str(), amount.0).into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(10),
                ),
            )
    }

    /// Private settlement callback for a withdraw transfer: the transfer
    /// receipt is promise 0. Success emits `funds_withdrawn`; failure
    /// refunds the treasury debit and emits `funds_withdraw_failed`.
    #[private]
    pub fn on_withdraw(&mut self, to: AccountId, amount: U128) {
        // Bounded read: a transfer receipt succeeds with empty data, so
        // `max_len` 0 accepts exactly that and rejects anything longer.
        let succeeded = env::promise_result_checked(0, 0).is_ok();
        self.settle_withdraw(&to, amount.0, succeeded);
    }

    /// Shared settlement core so unit tests can cover both branches
    /// without executing promises (the host mock cannot produce a
    /// transfer result; the balance assertions belong in the sandbox
    /// round trip instead). Success keeps the debit and emits
    /// `funds_withdrawn`; failure restores the debit via
    /// `saturating_add` and emits `funds_withdraw_failed`.
    fn settle_withdraw(&mut self, to: &AccountId, amount: u128, succeeded: bool) {
        if succeeded {
            log_funds_withdrawn(to, amount);
        } else {
            self.treasury_yocto = self.treasury_yocto.saturating_add(amount);
            log_funds_withdraw_failed(to, amount);
        }
    }

    /// Logical treasury balance (sum of `deposit_fleet_funds` minus
    /// `withdraw_fleet_funds`). Direct transfers bypassing
    /// `deposit_fleet_funds` do not credit it.
    pub fn treasury(&self) -> U128 {
        U128::from(self.treasury_yocto)
    }

    /// Fleet rollup: treasury, agent count, and approval-queue depth.
    /// `pending_queue` is exactly `list_queue().len()` (held requests
    /// awaiting a human decision); staged, paid, and rejected requests
    /// never count toward it.
    pub fn fleet_summary(&self) -> FleetSummary {
        FleetSummary {
            treasury_yocto: U128::from(self.treasury_yocto),
            agent_count: self.agents.len() as u64,
            pending_queue: self.list_queue().len() as u64,
        }
    }
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
    fn settle_withdraw_success_keeps_treasury_debited() {
        let mut guard = fresh_guard();
        deposit_as("anyone.near", FIVE_NEAR);
        guard.deposit_fleet_funds();

        set_predecessor(OWNER);
        let to: AccountId = "owner.testnet".parse().unwrap();
        let _ = guard.withdraw_fleet_funds(to.clone(), U128::from(ONE_NEAR));
        assert_eq!(guard.treasury(), U128::from(FIVE_NEAR - ONE_NEAR));
        guard.settle_withdraw(&to, ONE_NEAR, true);
        assert_eq!(guard.treasury(), U128::from(FIVE_NEAR - ONE_NEAR));
    }

    #[test]
    fn settle_withdraw_failure_restores_treasury() {
        let mut guard = fresh_guard();
        deposit_as("anyone.near", FIVE_NEAR);
        guard.deposit_fleet_funds();

        set_predecessor(OWNER);
        let to: AccountId = "ghost.testnet".parse().unwrap();
        let _ = guard.withdraw_fleet_funds(to.clone(), U128::from(ONE_NEAR));
        assert_eq!(guard.treasury(), U128::from(FIVE_NEAR - ONE_NEAR));
        guard.settle_withdraw(&to, ONE_NEAR, false);
        assert_eq!(guard.treasury(), U128::from(FIVE_NEAR));
    }

    #[test]
    fn settle_withdraw_success_leaves_no_double_debit() {
        let mut guard = fresh_guard();
        deposit_as("anyone.near", FIVE_NEAR);
        guard.deposit_fleet_funds();

        set_predecessor(OWNER);
        let to: AccountId = "owner.testnet".parse().unwrap();
        let _ = guard.withdraw_fleet_funds(to.clone(), U128::from(ONE_NEAR));
        guard.settle_withdraw(&to, ONE_NEAR, true);
        // The remaining balance is still withdrawable in full: the
        // success path debited exactly once.
        let _ = guard.withdraw_fleet_funds(to.clone(), U128::from(FIVE_NEAR - ONE_NEAR));
        assert_eq!(guard.treasury(), U128::from(0));
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
