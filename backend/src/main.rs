#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    core_api::run().await
}
