//! Device-local lifecycle state for starting automatic reading rounds.
//!
//! Android ignores its first resume event, so a newly created runtime starts
//! visible with one catch-up request. Lifecycle events never change sync policy.

#[derive(Clone, Copy, Debug)]
pub(super) struct ForegroundGate {
    visible: bool,
    pending: bool,
}

impl ForegroundGate {
    pub(super) const fn new() -> Self {
        Self {
            visible: true,
            pending: true,
        }
    }

    pub(super) fn set_visible(&mut self, visible: bool) {
        if visible && !self.visible {
            self.pending = true;
        }
        self.visible = visible;
    }

    pub(super) fn visible(&self) -> bool {
        self.visible
    }

    pub(super) fn claim(&mut self, allowed: bool, now: i64, last_attempt: i64) -> bool {
        if !self.visible || !allowed {
            return false;
        }
        if !self.pending && now.saturating_sub(last_attempt) < 60 {
            return false;
        }
        self.pending = false;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_start_catches_up_even_with_a_recent_persisted_attempt() {
        let mut gate = ForegroundGate::new();
        assert!(gate.claim(true, 100, 99));
        assert!(!gate.claim(true, 101, 100));
    }

    #[test]
    fn returning_catches_up_before_the_normal_interval() {
        let mut gate = ForegroundGate::new();
        assert!(gate.claim(true, 100, 99));
        gate.set_visible(false);
        gate.set_visible(true);
        assert!(gate.claim(true, 103, 100));
        assert!(!gate.claim(true, 104, 103));
    }

    #[test]
    fn background_does_not_start_an_overdue_or_pending_round() {
        let mut gate = ForegroundGate::new();
        gate.set_visible(false);
        assert!(!gate.claim(true, 1000, 0));
        gate.set_visible(true);
        assert!(gate.claim(true, 1000, 999));
    }

    #[test]
    fn disabled_policy_does_not_consume_the_catch_up_request() {
        let mut gate = ForegroundGate::new();
        assert!(!gate.claim(false, 100, 99));
        assert!(gate.claim(true, 101, 100));
        gate.set_visible(false);
        gate.set_visible(true);
        assert!(!gate.claim(false, 102, 101));
        assert!(gate.claim(true, 103, 102));
    }

    #[test]
    fn duplicate_resumes_coalesce_without_restarting_an_already_claimed_round() {
        let mut gate = ForegroundGate::new();
        gate.set_visible(true);
        gate.set_visible(true);
        assert!(gate.claim(true, 100, 99));
        gate.set_visible(true);
        assert!(!gate.claim(true, 101, 100));
        gate.set_visible(false);
        gate.set_visible(true);
        gate.set_visible(true);
        assert!(gate.claim(true, 102, 101));
        assert!(!gate.claim(true, 103, 102));
    }

    #[test]
    fn visible_periodic_rounds_keep_the_existing_interval() {
        let mut gate = ForegroundGate::new();
        assert!(gate.claim(true, 100, 99));
        assert!(!gate.claim(true, 159, 100));
        assert!(gate.claim(true, 160, 100));
    }

    #[test]
    fn suspend_while_waiting_for_the_sync_lock_blocks_the_queued_request() {
        let mut gate = ForegroundGate::new();
        assert!(gate.visible());
        gate.set_visible(false);
        // The scheduler claims only after acquiring the shared transport lock.
        assert!(!gate.claim(true, 100, 0));
        gate.set_visible(true);
        assert!(gate.claim(true, 101, 100));
    }
}
