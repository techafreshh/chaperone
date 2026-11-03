use near_sdk::near;

// Walking-skeleton guard contract. Full guard logic (agent registry,
// verdicts, holds, kill-switch, events) lands in later laps per PRD §12.
#[near(contract_state)]
#[derive(Debug, Default)]
pub struct Guard {
    spent_today: u128,
    daily_allowance: u128,
}

#[near]
impl Guard {
    #[init]
    pub fn new(daily_allowance: u128) -> Self {
        Self {
            spent_today: 0,
            daily_allowance,
        }
    }

    pub fn daily_allowance(&self) -> u128 {
        self.daily_allowance
    }
}

impl Guard {
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
    fn constructor_defaults_to_zero_spend() {
        let guard = Guard::default();
        assert_eq!(guard.spent_today, 0);
        assert_eq!(guard.daily_allowance, 0);
        assert!(Guard::within_allowance(
            guard.spent_today,
            guard.daily_allowance
        ));
    }
}
