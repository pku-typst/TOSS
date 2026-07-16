//! Localized distribution text and its file-validation policy.

use super::file_format::LocalizedTextFile;

#[derive(Clone, Debug, serde::Serialize, utoipa::ToSchema)]
pub struct LocalizedText {
    pub en: String,
    #[serde(rename = "zh-CN")]
    pub zh_cn: String,
}

pub(super) fn validate_localized_text(
    value: LocalizedTextFile,
    field: &str,
    max_chars: usize,
) -> Result<LocalizedText, String> {
    let en = value.en.trim().to_string();
    let zh_cn = value.zh_cn.trim().to_string();
    for (locale, text) in [("en", &en), ("zh-CN", &zh_cn)] {
        if text.is_empty() || text.chars().count() > max_chars || text.chars().any(char::is_control)
        {
            return Err(format!(
                "{field}.{locale} must contain between 1 and {max_chars} printable characters"
            ));
        }
    }
    Ok(LocalizedText { en, zh_cn })
}

#[cfg(test)]
mod tests {
    use super::LocalizedText;

    #[test]
    fn localized_text_uses_the_canonical_locale_key() -> Result<(), serde_json::Error> {
        let value = serde_json::to_value(LocalizedText {
            en: "English".to_string(),
            zh_cn: "中文".to_string(),
        })?;
        assert_eq!(
            value.get("en").and_then(|text| text.as_str()),
            Some("English")
        );
        assert_eq!(
            value.get("zh-CN").and_then(|text| text.as_str()),
            Some("中文")
        );
        assert!(value.get("zh_cn").is_none());
        Ok(())
    }
}
