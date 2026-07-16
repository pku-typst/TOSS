//! Validated product policy for the optional browser AI assistant.

use super::file_format::{AiAssistantFile, AiConnectionPolicyFile};
use super::{validate_localized_text, LocalizedText};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use url::Url;
use utoipa::ToSchema;

const MAX_MODEL_PROFILES: usize = 128;
const MAX_REQUEST_OVERRIDE_BYTES: usize = 16_384;
const MAX_REQUEST_OVERRIDE_DEPTH: usize = 8;
const MAX_REQUEST_OVERRIDE_ENTRIES: usize = 128;
const MAX_REQUEST_OVERRIDE_ARRAY_LENGTH: usize = 128;
const MAX_REQUEST_OVERRIDE_KEY_LENGTH: usize = 128;
const MAX_REQUEST_OVERRIDE_STRING_LENGTH: usize = 8_192;
const MIN_CONTEXT_WINDOW: u64 = 8_192;
const MAX_CONTEXT_WINDOW: u64 = 4_194_304;
const MIN_MAX_OUTPUT_TOKENS: u64 = 256;
const MAX_MAX_OUTPUT_TOKENS: u64 = 1_048_576;
const CONTEXT_SAFETY_TOKENS: u64 = 4_096;
const MIN_INPUT_TOKENS: u64 = 1_024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AiConnectionPolicyKind {
    UserDefined,
    ManagedCatalog,
}

#[derive(Clone, Debug)]
pub enum AiAssistantConfig {
    UserDefined,
    ManagedCatalog(Box<ManagedAiCatalogConfig>),
}

impl AiAssistantConfig {
    pub fn kind(&self) -> AiConnectionPolicyKind {
        match self {
            Self::UserDefined => AiConnectionPolicyKind::UserDefined,
            Self::ManagedCatalog(_) => AiConnectionPolicyKind::ManagedCatalog,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ManagedAiCatalogConfig {
    pub provider: ManagedAiProviderConfig,
    pub default_model_profile: String,
    pub model_profiles: Vec<ManagedAiModelProfile>,
}

#[derive(Clone, Debug)]
pub struct ManagedAiProviderConfig {
    pub id: String,
    pub label: LocalizedText,
    pub credential_label: LocalizedText,
    pub protocol: String,
    pub base_url: String,
    pub origin: String,
    pub catalog: String,
}

#[derive(Clone, Debug)]
pub struct ManagedAiModelProfile {
    pub id: String,
    pub model: String,
    pub label: LocalizedText,
    pub context_window: u64,
    pub max_output_tokens: u64,
    pub reasoning: bool,
    pub request_overrides: Map<String, Value>,
}

pub(super) fn load_ai_assistant(
    file: Option<AiAssistantFile>,
    included: bool,
) -> Result<Option<AiAssistantConfig>, String> {
    match (included, file) {
        (false, None) => Ok(None),
        (false, Some(_)) => Err(
            "ai_assistant must be omitted unless frontend_features includes ai_assistant"
                .to_string(),
        ),
        (true, None) => {
            Err("ai_assistant is required when frontend_features includes ai_assistant".to_string())
        }
        (true, Some(file)) => load_connection_policy(file.connection_policy).map(Some),
    }
}

fn load_connection_policy(file: AiConnectionPolicyFile) -> Result<AiAssistantConfig, String> {
    match file {
        AiConnectionPolicyFile::UserDefined => Ok(AiAssistantConfig::UserDefined),
        AiConnectionPolicyFile::ManagedCatalog {
            provider,
            default_model_profile,
            model_profiles,
        } => {
            if model_profiles.is_empty() || model_profiles.len() > MAX_MODEL_PROFILES {
                return Err(format!(
                    "ai_assistant managed_catalog must define between 1 and {MAX_MODEL_PROFILES} model profiles"
                ));
            }
            let provider_id = validate_slug(&provider.id, "ai_assistant provider.id")?;
            let provider_label =
                validate_localized_text(provider.label, "ai_assistant provider.label", 80)?;
            let credential_label = validate_localized_text(
                provider.credential_label,
                "ai_assistant provider.credential_label",
                80,
            )?;
            if provider.protocol != "openai-completions" {
                return Err(
                    "ai_assistant managed_catalog provider.protocol must be openai-completions"
                        .to_string(),
                );
            }
            if provider.catalog != "openai-models" {
                return Err(
                    "ai_assistant managed_catalog provider.catalog must be openai-models"
                        .to_string(),
                );
            }
            let (base_url, origin) = validate_base_url(&provider.base_url)?;
            let mut normalized_profiles = Vec::with_capacity(model_profiles.len());
            let mut ids = HashSet::with_capacity(model_profiles.len());
            let mut models = HashSet::with_capacity(model_profiles.len());
            for profile in model_profiles {
                let id = validate_slug(&profile.id, "ai_assistant model_profiles[].id")?;
                if !ids.insert(id.clone()) {
                    return Err(
                        "ai_assistant managed_catalog model profile IDs must be unique".to_string(),
                    );
                }
                let model = validate_model_id(&profile.model)?;
                if !models.insert(model.clone()) {
                    return Err(
                        "ai_assistant managed_catalog upstream model IDs must be unique"
                            .to_string(),
                    );
                }
                validate_token_budget(profile.context_window, profile.max_output_tokens)?;
                validate_request_overrides(&profile.request_overrides)?;
                normalized_profiles.push(ManagedAiModelProfile {
                    id,
                    model,
                    label: validate_localized_text(
                        profile.label,
                        "ai_assistant model_profiles[].label",
                        100,
                    )?,
                    context_window: profile.context_window,
                    max_output_tokens: profile.max_output_tokens,
                    reasoning: profile.reasoning,
                    request_overrides: profile.request_overrides,
                });
            }
            let default_model_profile = default_model_profile.trim().to_string();
            if !ids.contains(&default_model_profile) {
                return Err(
                    "ai_assistant managed_catalog default_model_profile must name a configured profile"
                        .to_string(),
                );
            }
            Ok(AiAssistantConfig::ManagedCatalog(Box::new(
                ManagedAiCatalogConfig {
                    provider: ManagedAiProviderConfig {
                        id: provider_id,
                        label: provider_label,
                        credential_label,
                        protocol: provider.protocol,
                        base_url,
                        origin,
                        catalog: provider.catalog,
                    },
                    default_model_profile,
                    model_profiles: normalized_profiles,
                },
            )))
        }
    }
}

fn validate_slug(raw: &str, field: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(format!(
            "{field} must contain only lowercase ASCII letters, digits, and hyphens"
        ));
    }
    Ok(value.to_string())
}

fn validate_base_url(raw: &str) -> Result<(String, String), String> {
    let mut url = Url::parse(raw.trim())
        .map_err(|_| "ai_assistant managed_catalog provider.base_url is invalid".to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "ai_assistant managed_catalog provider.base_url must be a credential-free HTTPS base URL"
                .to_string(),
        );
    }
    if !url.path().ends_with('/') {
        let normalized_path = format!("{}/", url.path());
        url.set_path(&normalized_path);
    }
    let origin = url.origin().ascii_serialization();
    Ok((url.to_string(), origin))
}

fn validate_model_id(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(
            "ai_assistant managed_catalog model ID must contain between 1 and 256 non-whitespace printable characters"
                .to_string(),
        );
    }
    Ok(value.to_string())
}

fn validate_token_budget(context_window: u64, max_output_tokens: u64) -> Result<(), String> {
    if !(MIN_CONTEXT_WINDOW..=MAX_CONTEXT_WINDOW).contains(&context_window)
        || !(MIN_MAX_OUTPUT_TOKENS..=MAX_MAX_OUTPUT_TOKENS).contains(&max_output_tokens)
        || max_output_tokens + CONTEXT_SAFETY_TOKENS + MIN_INPUT_TOKENS > context_window
    {
        return Err(
            "ai_assistant managed_catalog model token budget is outside supported bounds"
                .to_string(),
        );
    }
    Ok(())
}

fn normalized_secret_key(key: &str) -> String {
    key.to_ascii_lowercase().replace(['-', '_'], "")
}

fn validate_request_overrides(value: &Map<String, Value>) -> Result<(), String> {
    const PROTECTED_ROOT_KEYS: [&str; 14] = [
        "model",
        "messages",
        "input",
        "instructions",
        "system",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "stream",
        "stream_options",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
        "headers",
    ];
    if value
        .keys()
        .any(|key| PROTECTED_ROOT_KEYS.contains(&key.as_str()))
    {
        return Err(
            "ai_assistant managed_catalog request_overrides contains an Agent-owned field"
                .to_string(),
        );
    }
    let serialized = serde_json::to_vec(value)
        .map_err(|_| "ai_assistant managed_catalog request_overrides is invalid".to_string())?;
    if serialized.len() > MAX_REQUEST_OVERRIDE_BYTES {
        return Err(
            "ai_assistant managed_catalog request_overrides exceeds the size limit".to_string(),
        );
    }
    let mut entries = 0;
    validate_json_value(&Value::Object(value.clone()), 0, &mut entries)
}

fn validate_json_value(value: &Value, depth: usize, entries: &mut usize) -> Result<(), String> {
    if depth > MAX_REQUEST_OVERRIDE_DEPTH {
        return Err(
            "ai_assistant managed_catalog request_overrides exceeds the depth limit".to_string(),
        );
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(text) if text.len() <= MAX_REQUEST_OVERRIDE_STRING_LENGTH => Ok(()),
        Value::String(_) => Err(
            "ai_assistant managed_catalog request_overrides contains an oversized string"
                .to_string(),
        ),
        Value::Array(values) => {
            if values.len() > MAX_REQUEST_OVERRIDE_ARRAY_LENGTH {
                return Err(
                    "ai_assistant managed_catalog request_overrides contains an oversized array"
                        .to_string(),
                );
            }
            for item in values {
                *entries += 1;
                if *entries > MAX_REQUEST_OVERRIDE_ENTRIES {
                    return Err(
                        "ai_assistant managed_catalog request_overrides has too many entries"
                            .to_string(),
                    );
                }
                validate_json_value(item, depth + 1, entries)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for (key, item) in values {
                *entries += 1;
                let normalized = normalized_secret_key(key);
                if *entries > MAX_REQUEST_OVERRIDE_ENTRIES
                    || key.is_empty()
                    || key.len() > MAX_REQUEST_OVERRIDE_KEY_LENGTH
                    || matches!(key.as_str(), "__proto__" | "constructor" | "prototype")
                    || matches!(
                        normalized.as_str(),
                        "authorization"
                            | "proxyauthorization"
                            | "apikey"
                            | "accesstoken"
                            | "bearertoken"
                            | "token"
                            | "credential"
                            | "credentials"
                            | "password"
                            | "secret"
                            | "clientsecret"
                    )
                {
                    return Err(
                        "ai_assistant managed_catalog request_overrides contains an unsafe key"
                            .to_string(),
                    );
                }
                validate_json_value(item, depth + 1, entries)?;
            }
            Ok(())
        }
    }
}
