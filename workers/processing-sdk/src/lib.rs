//! Public worker agent mechanics with a narrow typed processor boundary.

mod agent;
mod client;
mod input;
pub mod protocol;

pub use agent::{
    run_agent, AgentConfig, AgentError, Processor, ProcessorArtifact, ProcessorDescriptor,
    ProcessorFailure, ProcessorRequest, ProcessorResult,
};
pub use input::{safe_relative_path, ProjectBundleFile, ProjectBundleManifest};
pub use protocol::{WorkerClaimLimits, WorkerFailureClass};
