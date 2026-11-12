use near_sdk::json_types::U128;
use near_sdk::AccountId;

use crate::request::PaymentRequest;

/// Escape a string for embedding inside a JSON double-quoted value.
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

/// Pure envelope constructor: `EVENT_JSON:` plus the
/// `chaperone/1.0.0` standard event object. `data` must already be a
/// JSON value (object, array, `null`, ...). Pure so unit tests can
/// assert the envelope without a blockchain mock.
pub(crate) fn format_event(event: &str, data: &str) -> String {
    format!(
        "EVENT_JSON:{{\"standard\":\"chaperone\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":{}}}",
        event, data
    )
}

/// Emit one standard event to the transaction receipt logs.
pub(crate) fn emit(event: &str, data: &str) {
    near_sdk::env::log_str(&format_event(event, data));
}

fn allowlist_json(payee_allowlist: &[AccountId]) -> String {
    let mut list = String::from("[");
    for (i, payee) in payee_allowlist.iter().enumerate() {
        if i > 0 {
            list.push(',');
        }
        list.push('"');
        list.push_str(&escape_json(payee.as_str()));
        list.push('"');
    }
    list.push(']');
    list
}

pub(crate) fn log_agent_registered(
    agent_id: &AccountId,
    daily_allowance_yocto: U128,
    per_payment_cap_yocto: U128,
    payee_allowlist: &[AccountId],
) {
    let data = format!(
        "{{\"agent_id\":\"{}\",\"daily_allowance_yocto\":\"{}\",\"per_payment_cap_yocto\":\"{}\",\"payee_allowlist\":{}}}",
        escape_json(agent_id.as_str()),
        daily_allowance_yocto.0,
        per_payment_cap_yocto.0,
        allowlist_json(payee_allowlist)
    );
    emit("agent_registered", &data);
}

pub(crate) fn log_policy_updated(
    agent_id: &AccountId,
    daily_allowance_yocto: U128,
    per_payment_cap_yocto: U128,
) {
    let data = format!(
        "{{\"agent_id\":\"{}\",\"daily_allowance_yocto\":\"{}\",\"per_payment_cap_yocto\":\"{}\"}}",
        escape_json(agent_id.as_str()),
        daily_allowance_yocto.0,
        per_payment_cap_yocto.0
    );
    emit("policy_updated", &data);
}

pub(crate) fn log_agent_killed(agent_id: &AccountId) {
    let data = format!("{{\"agent_id\":\"{}\"}}", escape_json(agent_id.as_str()));
    emit("agent_killed", &data);
}

pub(crate) fn log_agent_reenabled(agent_id: &AccountId) {
    let data = format!("{{\"agent_id\":\"{}\"}}", escape_json(agent_id.as_str()));
    emit("agent_reenabled", &data);
}

pub(crate) fn log_payees_updated(agent_id: &AccountId, payee_allowlist: &[AccountId]) {
    let data = format!(
        "{{\"agent_id\":\"{}\",\"payee_allowlist\":{}}}",
        escape_json(agent_id.as_str()),
        allowlist_json(payee_allowlist)
    );
    emit("payees_updated", &data);
}

pub(crate) fn log_verifier_set(public_key_base58: Option<&str>) {
    let key = match public_key_base58 {
        Some(key) => format!("\"{}\"", escape_json(key)),
        None => "null".to_string(),
    };
    let data = format!("{{\"public_key_base58\":{}}}", key);
    emit("verifier_set", &data);
}

pub(crate) fn log_purpose_ref_registered(
    ref_id: &str,
    vendor: &str,
    payee: &AccountId,
    max_amount_yocto: U128,
    description: &str,
) {
    let data = format!(
        "{{\"ref_id\":\"{}\",\"vendor\":\"{}\",\"payee\":\"{}\",\"max_amount_yocto\":\"{}\",\"description\":\"{}\"}}",
        escape_json(ref_id),
        escape_json(vendor),
        escape_json(payee.as_str()),
        max_amount_yocto.0,
        escape_json(description)
    );
    emit("purpose_ref_registered", &data);
}

pub(crate) fn log_purpose_ref_closed(ref_id: &str) {
    let data = format!("{{\"ref_id\":\"{}\"}}", escape_json(ref_id));
    emit("purpose_ref_closed", &data);
}

pub(crate) fn log_funds_deposited(account: &AccountId, amount_yocto: u128) {
    let data = format!(
        "{{\"account\":\"{}\",\"amount_yocto\":\"{}\"}}",
        escape_json(account.as_str()),
        amount_yocto
    );
    emit("funds_deposited", &data);
}

pub(crate) fn log_funds_withdrawn(to: &AccountId, amount_yocto: u128) {
    let data = format!(
        "{{\"to\":\"{}\",\"amount_yocto\":\"{}\"}}",
        escape_json(to.as_str()),
        amount_yocto
    );
    emit("funds_withdrawn", &data);
}

pub(crate) fn log_funds_withdraw_failed(to: &AccountId, amount_yocto: u128) {
    let data = format!(
        "{{\"to\":\"{}\",\"amount_yocto\":\"{}\"}}",
        escape_json(to.as_str()),
        amount_yocto
    );
    emit("funds_withdraw_failed", &data);
}

pub(crate) fn log_request_created(request: &PaymentRequest) {
    let data = format!(
        "{{\"request_id\":{},\"agent_id\":\"{}\",\"payee\":\"{}\",\"amount_yocto\":\"{}\",\"purpose_ref\":\"{}\",\"vendor\":\"{}\",\"memo\":\"{}\"}}",
        request.request_id,
        escape_json(request.agent_id.as_str()),
        escape_json(request.payee.as_str()),
        request.amount_yocto.0,
        escape_json(&request.purpose_ref),
        escape_json(&request.vendor),
        escape_json(&request.memo)
    );
    emit("request_created", &data);
}

pub(crate) fn log_request_rejected(request: &PaymentRequest) {
    let reason = request.reason.as_deref().unwrap_or("");
    let data = format!(
        "{{\"request_id\":{},\"agent_id\":\"{}\",\"reason\":\"{}\"}}",
        request.request_id,
        escape_json(request.agent_id.as_str()),
        escape_json(reason)
    );
    emit("request_rejected", &data);
}

pub(crate) fn log_request_failed(request: &PaymentRequest) {
    let reason = request.reason.as_deref().unwrap_or("");
    let data = format!(
        "{{\"request_id\":{},\"agent_id\":\"{}\",\"reason\":\"{}\"}}",
        request.request_id,
        escape_json(request.agent_id.as_str()),
        escape_json(reason)
    );
    emit("request_failed", &data);
}

pub(crate) fn log_verdict_recorded(request_id: u64, consistent: bool) {
    let data = format!(
        "{{\"request_id\":{},\"consistent\":{}}}",
        request_id, consistent
    );
    emit("verdict_recorded", &data);
}

pub(crate) fn log_request_held(request: &PaymentRequest) {
    let data = format!(
        "{{\"request_id\":{},\"agent_id\":\"{}\"}}",
        request.request_id,
        escape_json(request.agent_id.as_str())
    );
    emit("request_held", &data);
}

pub(crate) fn log_request_paid(request: &PaymentRequest) {
    let data = format!(
        "{{\"request_id\":{},\"agent_id\":\"{}\",\"payee\":\"{}\",\"amount_yocto\":\"{}\"}}",
        request.request_id,
        escape_json(request.agent_id.as_str()),
        escape_json(request.payee.as_str()),
        request.amount_yocto.0
    );
    emit("request_paid", &data);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_event_has_event_json_prefix() {
        let out = format_event(
            "agent_registered",
            "{\"agent_id\":\"alice.near\"}",
        );
        assert!(
            out.starts_with(
                "EVENT_JSON:{\"standard\":\"chaperone\",\"version\":\"1.0.0\",\"event\":\"agent_registered\""
            ),
            "unexpected envelope: {out}"
        );
    }

    #[test]
    fn format_event_wraps_data_verbatim() {
        let out = format_event("verdict_recorded", "{\"request_id\":1,\"consistent\":true}");
        assert_eq!(
            out,
            "EVENT_JSON:{\"standard\":\"chaperone\",\"version\":\"1.0.0\",\"event\":\"verdict_recorded\",\"data\":{\"request_id\":1,\"consistent\":true}}"
        );
    }

    #[test]
    fn escape_json_handles_quotes_and_backslash() {
        assert_eq!(escape_json("a\"b\\c"), "a\\\"b\\\\c");
    }
}
