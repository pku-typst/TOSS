use std::env;
use std::fs;
use std::io;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output_path = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("usage: export_worker_protocol <output-path>"))?;
    let document = core_api::protocol::worker_openapi_document();
    let mut json = serde_json::to_string_pretty(&document)?;
    json.push('\n');
    fs::write(output_path, json)?;
    Ok(())
}
