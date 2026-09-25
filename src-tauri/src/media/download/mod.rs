pub(crate) mod progress;
pub(crate) mod validation;
pub(crate) mod worker;

pub(crate) use progress::{update_media_progress, MediaProgressTracker};

pub(crate) use worker::{
    json_number, resume_media_worker_when_idle, run_media_worker,
    run_media_worker_with_completion_options, run_media_worker_with_options,
};

#[cfg(test)]
pub(crate) use validation::duration_needs_normalization;
#[cfg(test)]
pub(crate) use worker::{minimum_acceptable_duration, newest_completed_media};
