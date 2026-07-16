mod access;
mod app_state;
mod audit;
mod collaboration;
mod database_error;
mod deployment_config;
mod distribution;
mod document_processing;
mod experience;
mod external_repositories;
mod http_response;
mod latex_runtime;
mod object_cleanup;
mod object_storage;
pub mod protocol;
mod server;
mod templates;
mod text_enum;
mod typst_runtime;
mod versioning;
mod workspace;

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    server::run().await
}
