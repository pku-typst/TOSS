use base64::engine::general_purpose::URL_SAFE_NO_PAD;

pub(super) fn extract_groups_from_id_token(raw_id_token: String, claim_name: &str) -> Vec<String> {
    let Some(claims) = decode_jwt_claims(&raw_id_token) else {
        return Vec::new();
    };
    let mut groups = match claims.get(claim_name) {
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|group| !group.is_empty())
            .map(str::to_string)
            .collect(),
        Some(serde_json::Value::String(group)) => {
            let group = group.trim();
            if group.is_empty() {
                Vec::new()
            } else {
                vec![group.to_string()]
            }
        }
        _ => Vec::new(),
    };
    groups.sort();
    groups.dedup();
    groups
}

fn decode_jwt_claims(raw_token: &str) -> Option<serde_json::Value> {
    let mut parts = raw_token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let bytes = base64::Engine::decode(&URL_SAFE_NO_PAD, payload).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::extract_groups_from_id_token;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    #[test]
    fn group_claims_are_trimmed_sorted_and_deduplicated() -> Result<(), serde_json::Error> {
        let payload = serde_json::to_vec(&serde_json::json!({
            "groups": [" writers ", "readers", "writers", ""]
        }))?;
        let encoded = base64::Engine::encode(&URL_SAFE_NO_PAD, payload);
        let token = format!("header.{encoded}.signature");
        assert_eq!(
            extract_groups_from_id_token(token, "groups"),
            vec!["readers".to_string(), "writers".to_string()]
        );
        Ok(())
    }
}
