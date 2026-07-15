use sha2::{Digest, Sha256};

pub const MANIFEST: &str = include_str!("../processor-contract.json");

pub fn processor_contract() -> String {
    format!("sha256:{}", hex_digest(MANIFEST.as_bytes()))
}

pub fn development_processor_contract() -> String {
    let mut content = MANIFEST.as_bytes().to_vec();
    content.extend_from_slice(b"\0executor=process-development");
    format!("sha256:{}", hex_digest(&content))
}

fn hex_digest(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{development_processor_contract, processor_contract, MANIFEST};

    #[test]
    fn processor_contract_is_exact_sha256_identity() {
        assert!(serde_json::from_str::<serde_json::Value>(MANIFEST).is_ok());
        let contract = processor_contract();
        assert_eq!(contract.len(), "sha256:".len() + 64);
        assert_ne!(contract, development_processor_contract());
    }
}
