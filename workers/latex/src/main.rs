mod contract;
mod processor;

use processor::LatexProcessor;
use std::sync::Arc;
use toss_processing_sdk::{run_agent, AgentConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
        Some("contract") => {
            println!("{}", contract::processor_contract());
            return Ok(());
        }
        Some("manifest") => {
            println!("{}", contract::MANIFEST.trim());
            return Ok(());
        }
        Some(argument) => {
            return Err(format!("unknown argument {argument}").into());
        }
        None => {}
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "toss_processing_sdk=info,toss_latex_worker=info".into()),
        )
        .init();
    let config = AgentConfig::from_env()?;
    let processor = Arc::new(LatexProcessor::from_env()?);
    run_agent(config, processor).await?;
    Ok(())
}
