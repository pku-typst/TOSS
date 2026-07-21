//! Public worker agent mechanics with a narrow typed processor boundary.

mod agent;
mod client;
mod input;
pub mod protocol;

pub use agent::{
    run_agent, run_agent_with_processors, AgentConfig, AgentError, Processor, ProcessorArtifact,
    ProcessorDescriptor, ProcessorFailure, ProcessorRequest, ProcessorResult,
};
pub use input::{
    safe_relative_path, BinaryInput, ProcessorInput, ProjectBundleFile, ProjectBundleManifest,
    ProjectInput,
};
pub use protocol::{WorkerClaimLimits, WorkerFailureClass};
