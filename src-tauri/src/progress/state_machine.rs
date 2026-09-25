use super::model::JobPhase;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JobStateMachine {
    phase: JobPhase,
    attempt: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransitionError {
    InvalidTransition { from: JobPhase, to: JobPhase },
    RetryNotAllowed { from: JobPhase },
}

impl JobStateMachine {
    pub(crate) fn new() -> Self {
        Self {
            phase: JobPhase::Queued,
            attempt: 0,
        }
    }

    pub(crate) fn from_phase(phase: JobPhase, attempt: u32) -> Self {
        Self { phase, attempt }
    }

    pub(crate) fn phase(self) -> JobPhase {
        self.phase
    }

    pub(crate) fn attempt(self) -> u32 {
        self.attempt
    }

    pub(crate) fn transition(&mut self, next: JobPhase) -> Result<(), TransitionError> {
        if valid_transition(self.phase, next) {
            self.phase = next;
            Ok(())
        } else {
            Err(TransitionError::InvalidTransition {
                from: self.phase,
                to: next,
            })
        }
    }

    pub(crate) fn begin_retry(&mut self) -> Result<(), TransitionError> {
        if matches!(self.phase, JobPhase::Failed | JobPhase::Cancelled) {
            self.phase = JobPhase::Queued;
            self.attempt = self.attempt.saturating_add(1);
            Ok(())
        } else {
            Err(TransitionError::RetryNotAllowed { from: self.phase })
        }
    }

    pub(crate) fn cancel(&mut self) -> Result<(), TransitionError> {
        self.transition(JobPhase::Cancelling)
    }

    pub(crate) fn process_terminated(&mut self) -> Result<(), TransitionError> {
        self.transition(JobPhase::Cancelled)
    }
}

fn valid_transition(from: JobPhase, to: JobPhase) -> bool {
    match to {
        JobPhase::Cancelling => matches!(
            from,
            JobPhase::Queued
                | JobPhase::Preparing
                | JobPhase::Downloading
                | JobPhase::PostProcessing
                | JobPhase::Finalizing
                | JobPhase::Paused
        ),
        JobPhase::Failed => matches!(
            from,
            JobPhase::Queued
                | JobPhase::Preparing
                | JobPhase::Downloading
                | JobPhase::PostProcessing
                | JobPhase::Finalizing
                | JobPhase::Paused
        ),
        JobPhase::Preparing => from == JobPhase::Queued,
        JobPhase::Downloading => matches!(from, JobPhase::Preparing | JobPhase::Paused),
        JobPhase::Paused => matches!(from, JobPhase::Preparing | JobPhase::Downloading),
        JobPhase::PostProcessing => from == JobPhase::Downloading,
        JobPhase::Finalizing => from == JobPhase::PostProcessing,
        JobPhase::Completed => from == JobPhase::Finalizing,
        JobPhase::Cancelled => from == JobPhase::Cancelling,
        JobPhase::Queued => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_normal_download_lifecycle() {
        let mut machine = JobStateMachine::new();
        for phase in [
            JobPhase::Preparing,
            JobPhase::Downloading,
            JobPhase::PostProcessing,
            JobPhase::Finalizing,
            JobPhase::Completed,
        ] {
            assert!(machine.transition(phase).is_ok());
        }
        assert_eq!(machine.phase(), JobPhase::Completed);
    }

    #[test]
    fn rejects_terminal_state_regressions() {
        let mut machine = JobStateMachine::from_phase(JobPhase::Completed, 0);
        assert!(machine.transition(JobPhase::Downloading).is_err());
        assert!(machine.transition(JobPhase::Failed).is_err());
        assert!(machine.begin_retry().is_err());
    }

    #[test]
    fn cancellation_wins_when_process_finishes_during_cancel() {
        let mut machine = JobStateMachine::from_phase(JobPhase::Downloading, 0);
        assert!(machine.cancel().is_ok());
        assert_eq!(machine.phase(), JobPhase::Cancelling);
        assert!(machine.process_terminated().is_ok());
        assert_eq!(machine.phase(), JobPhase::Cancelled);
        assert!(machine.transition(JobPhase::Completed).is_err());
    }

    #[test]
    fn retry_creates_a_new_attempt_from_failure() {
        let mut machine = JobStateMachine::from_phase(JobPhase::Failed, 2);
        assert!(machine.begin_retry().is_ok());
        assert_eq!(machine.phase(), JobPhase::Queued);
        assert_eq!(machine.attempt(), 3);
    }
}
