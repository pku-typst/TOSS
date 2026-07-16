use super::provider::{
    ExternalGitProvider, ExternalGitProviderRegistry, ForgeDialect, GitHubProvider,
    GitHubProviderConfig, OAuth2GitProvider, OAuth2GitProviderConfig, ProviderBrand,
    ProviderInstanceId, ProviderKind, RepositoryApiDialect,
};
use base64::engine::general_purpose;
use base64::Engine;
use reqwest::redirect::Policy;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExternalGitConfigFile {
    #[serde(default)]
    providers: Vec<ProviderInstanceDocument>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderInstanceDocument {
    id: ProviderInstanceId,
    kind: ProviderKind,
    brand: ProviderBrand,
    display_name: String,
    base_url: String,
    api_url: Option<String>,
    app_slug: Option<String>,
    client_id: String,
    redirect_uri: String,
    login_enabled: bool,
}

pub(crate) fn external_git_provider_registry_from_config(
    document: ExternalGitConfigFile,
    environment: &dyn Fn(&str) -> Option<String>,
) -> Result<ExternalGitProviderRegistry, String> {
    if document.providers.is_empty() {
        return Ok(ExternalGitProviderRegistry::default());
    }
    let token_encryption_key = token_encryption_key_from_environment(environment)?;
    let mut providers = Vec::with_capacity(document.providers.len());
    for configured in document.providers {
        let instance_id = configured.id.clone();
        let display_name = configured.display_name.trim().to_string();
        if display_name.is_empty() || display_name.len() > 100 {
            return Err(format!(
                "provider instance '{instance_id}' display_name must contain 1-100 characters"
            ));
        }
        let kind = configured.kind;
        let brand = configured.brand;
        if !brand.supports(kind) {
            return Err(format!(
                "provider instance '{instance_id}' brand '{brand}' is not valid for adapter kind '{kind}'"
            ));
        }
        let login_enabled = configured.login_enabled;
        let provider = match kind {
            ProviderKind::Gitea => ExternalGitProvider::oauth2(
                instance_id.clone(),
                display_name,
                brand,
                login_enabled,
                oauth2_provider_from_document(
                    &instance_id,
                    configured,
                    RepositoryApiDialect::Forge(ForgeDialect::Gitea),
                    Arc::clone(&token_encryption_key),
                    environment,
                )?,
            ),
            ProviderKind::Forgejo => ExternalGitProvider::oauth2(
                instance_id.clone(),
                display_name,
                brand,
                login_enabled,
                oauth2_provider_from_document(
                    &instance_id,
                    configured,
                    RepositoryApiDialect::Forge(ForgeDialect::Forgejo),
                    Arc::clone(&token_encryption_key),
                    environment,
                )?,
            ),
            ProviderKind::GitHub => ExternalGitProvider::github(
                instance_id.clone(),
                display_name,
                brand,
                login_enabled,
                github_provider_from_document(
                    &instance_id,
                    configured,
                    Arc::clone(&token_encryption_key),
                    environment,
                )?,
            ),
            ProviderKind::GitLab => ExternalGitProvider::oauth2(
                instance_id.clone(),
                display_name,
                brand,
                login_enabled,
                oauth2_provider_from_document(
                    &instance_id,
                    configured,
                    RepositoryApiDialect::GitLab,
                    Arc::clone(&token_encryption_key),
                    environment,
                )?,
            ),
        };
        providers.push(provider);
    }
    ExternalGitProviderRegistry::from_providers(providers)
        .map_err(|id| format!("duplicate provider instance ID '{id}'"))
}

fn oauth2_provider_from_document(
    instance_id: &ProviderInstanceId,
    configured: ProviderInstanceDocument,
    api: RepositoryApiDialect,
    token_encryption_key: Arc<[u8; 32]>,
    environment: &dyn Fn(&str) -> Option<String>,
) -> Result<OAuth2GitProvider, String> {
    let base_url = normalize_service_url(
        &configured.base_url,
        &format!("provider '{instance_id}' base_url"),
    )?;
    let (default_api_path, adapter_name) = match api {
        RepositoryApiDialect::GitLab => ("/api/v4", "gitlab"),
        RepositoryApiDialect::Forge(ForgeDialect::Gitea) => ("/api/v1", "gitea"),
        RepositoryApiDialect::Forge(ForgeDialect::Forgejo) => ("/api/v1", "forgejo"),
    };
    let default_api_url = format!("{base_url}{default_api_path}");
    let api_url = normalize_service_url(
        configured.api_url.as_deref().unwrap_or(&default_api_url),
        &format!("provider '{instance_id}' api_url"),
    )?;
    ensure_same_origin(&base_url, &api_url)?;
    if configured.app_slug.is_some() {
        return Err(format!(
            "provider instance '{instance_id}' app_slug is only valid for GitHub adapters"
        ));
    }
    let redirect_uri = normalize_callback_url(
        &configured.redirect_uri,
        &format!("provider '{instance_id}' redirect_uri"),
    )?;
    let client_id = required_public_client_id(instance_id, configured.client_id)?;
    let client_secret = provider_client_secret_from_environment(instance_id, environment)?;
    let http_client = provider_http_client(adapter_name, instance_id)?;
    Ok(OAuth2GitProvider::new(OAuth2GitProviderConfig {
        base_url,
        api_url,
        api,
        client_id,
        client_secret,
        redirect_uri,
        token_encryption_key,
        http_client,
    }))
}

fn github_provider_from_document(
    instance_id: &ProviderInstanceId,
    configured: ProviderInstanceDocument,
    token_encryption_key: Arc<[u8; 32]>,
    environment: &dyn Fn(&str) -> Option<String>,
) -> Result<GitHubProvider, String> {
    let base_url = normalize_service_url(
        &configured.base_url,
        &format!("provider '{instance_id}' base_url"),
    )?;
    let default_api_url = if base_url == "https://github.com" {
        "https://api.github.com".to_string()
    } else {
        format!("{base_url}/api/v3")
    };
    let api_url = normalize_service_url(
        configured.api_url.as_deref().unwrap_or(&default_api_url),
        &format!("provider '{instance_id}' api_url"),
    )?;
    let app_slug = required_document_value(instance_id, "app_slug", configured.app_slug)?;
    if app_slug.len() > 100
        || !app_slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(format!(
            "provider instance '{instance_id}' app_slug must contain only ASCII letters, digits, and hyphens"
        ));
    }
    let redirect_uri = normalize_callback_url(
        &configured.redirect_uri,
        &format!("provider '{instance_id}' redirect_uri"),
    )?;
    let client_id = required_public_client_id(instance_id, configured.client_id)?;
    let client_secret = provider_client_secret_from_environment(instance_id, environment)?;
    let http_client = provider_http_client("github", instance_id)?;
    Ok(GitHubProvider::new(GitHubProviderConfig {
        base_url,
        api_url,
        app_slug,
        client_id,
        client_secret,
        redirect_uri,
        token_encryption_key,
        http_client,
    }))
}

fn required_document_value(
    instance_id: &ProviderInstanceId,
    field: &str,
    value: Option<String>,
) -> Result<String, String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("provider instance '{instance_id}' requires {field}"))
}

fn required_public_client_id(
    instance_id: &ProviderInstanceId,
    value: String,
) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!(
            "provider instance '{instance_id}' client_id must not be empty"
        ));
    }
    Ok(value)
}

fn provider_client_secret_from_environment(
    instance_id: &ProviderInstanceId,
    environment: &dyn Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let instance_name = instance_id.as_str().replace('-', "_").to_ascii_uppercase();
    let environment_name = format!("EXTERNAL_GIT_{instance_name}_CLIENT_SECRET");
    environment(&environment_name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "provider instance '{instance_id}' requires environment variable {environment_name}"
            )
        })
}

fn token_encryption_key_from_environment(
    environment: &dyn Fn(&str) -> Option<String>,
) -> Result<Arc<[u8; 32]>, String> {
    const ENVIRONMENT_NAME: &str = "EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY";
    let encoded = environment(ENVIRONMENT_NAME)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!("external Git providers require environment variable {ENVIRONMENT_NAME}")
        })?;
    let decoded = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| format!("{ENVIRONMENT_NAME} must be base64 encoded"))?;
    let key: [u8; 32] = decoded
        .try_into()
        .map_err(|_| format!("{ENVIRONMENT_NAME} must decode to exactly 32 bytes"))?;
    Ok(Arc::new(key))
}

fn provider_http_client(
    adapter: &str,
    instance_id: &ProviderInstanceId,
) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .user_agent(format!("typst-collab-{adapter}/0.1"))
        .build()
        .map_err(|error| {
            format!("failed to initialize provider instance '{instance_id}' HTTP client: {error}")
        })
}

fn normalize_service_url(raw: &str, variable: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(raw).map_err(|_| format!("{variable} is not a valid URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{variable} must use http or https"));
    }
    if url.scheme() == "http" && !url.host_str().is_some_and(is_loopback_host) {
        return Err(format!(
            "{variable} must use https unless it targets a loopback development host"
        ));
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "{variable} must be an absolute service URL without credentials, query, or fragment"
        ));
    }
    let normalized_path = url.path().trim_end_matches('/').to_string();
    url.set_path(if normalized_path.is_empty() {
        "/"
    } else {
        &normalized_path
    });
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn normalize_callback_url(raw: &str, variable: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| format!("{variable} is not a valid URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || (url.scheme() == "http" && !url.host_str().is_some_and(is_loopback_host))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "{variable} must be an absolute HTTPS URL, except for loopback development"
        ));
    }
    Ok(url.to_string())
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn ensure_same_origin(base_url: &str, api_url: &str) -> Result<(), String> {
    let base =
        reqwest::Url::parse(base_url).map_err(|_| "invalid provider base URL".to_string())?;
    let api = reqwest::Url::parse(api_url).map_err(|_| "invalid provider API URL".to_string())?;
    if base.scheme() != api.scheme()
        || base.host_str() != api.host_str()
        || base.port_or_known_default() != api.port_or_known_default()
    {
        return Err("provider api_url must use the same origin as base_url".to_string());
    }
    Ok(())
}

pub(crate) fn external_git_url_has_same_origin(base_url: &str, candidate_url: &str) -> bool {
    ensure_same_origin(base_url, candidate_url).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct StandaloneProviderRegistryDocument {
        schema: u32,
        #[serde(flatten)]
        config: ExternalGitConfigFile,
    }

    fn provider_registry_from_toml(
        document: &str,
        environment: &dyn Fn(&str) -> Option<String>,
    ) -> Result<ExternalGitProviderRegistry, String> {
        let document: StandaloneProviderRegistryDocument = toml::from_str(document)
            .map_err(|error| format!("external Git config must be valid TOML: {error}"))?;
        if document.schema != 1 {
            return Err(format!(
                "external Git config schema {} is unsupported; expected 1",
                document.schema
            ));
        }
        external_git_provider_registry_from_config(document.config, environment)
    }

    #[test]
    fn api_url_must_share_the_provider_origin() {
        assert!(external_git_url_has_same_origin(
            "https://gitlab.example.com",
            "https://gitlab.example.com/api/v4"
        ));
        assert!(!external_git_url_has_same_origin(
            "https://gitlab.example.com",
            "https://evil.example.com/api/v4"
        ));
        assert!(normalize_service_url("http://gitlab.example.com", "test").is_err());
        assert!(normalize_service_url("http://127.0.0.1:8081", "test").is_ok());
    }

    #[test]
    fn registry_toml_uses_public_client_ids_and_deterministic_secret_names() -> Result<(), String> {
        let document = r#"
schema = 1

[[providers]]
id = "engineering-gitlab"
kind = "gitlab"
brand = "gitlab"
display_name = "Engineering GitLab"
base_url = "https://gitlab.engineering.example.test"
client_id = "public-client-id"
redirect_uri = "https://collab.example.test/v1/external-git/providers/engineering-gitlab/callback"
login_enabled = true
"#;
        let values = HashMap::from([
            (
                "EXTERNAL_GIT_ENGINEERING_GITLAB_CLIENT_SECRET",
                "client-secret",
            ),
            (
                "EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY",
                "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
            ),
        ]);

        let registry = provider_registry_from_toml(document, &|name| {
            values.get(name).map(ToString::to_string)
        })?;

        let provider = registry
            .get(
                &"engineering-gitlab"
                    .parse()
                    .map_err(|_| "invalid test ID")?,
            )
            .ok_or("provider missing")?;
        let authorization_url = reqwest::Url::parse(
            &provider
                .authorization_url("state")
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(
            authorization_url
                .query_pairs()
                .find_map(|(key, value)| (key == "client_id").then(|| value.into_owned())),
            Some("public-client-id".to_string())
        );
        Ok(())
    }

    #[test]
    fn registry_toml_rejects_legacy_secret_environment_mappings() {
        let document = r#"
schema = 1

[[providers]]
id = "gitlab"
kind = "gitlab"
brand = "gitlab"
display_name = "GitLab"
base_url = "https://gitlab.example.test"
client_id = "client-id"
client_secret_env = "CUSTOM_CLIENT_SECRET"
redirect_uri = "https://collab.example.test/v1/external-git/providers/gitlab/callback"
login_enabled = false
"#;

        assert!(provider_registry_from_toml(document, &|_| None)
            .is_err_and(|error| error.contains("unknown field `client_secret_env`")));
    }

    #[test]
    fn registry_config_supports_multiple_instances_of_one_adapter_kind() -> Result<(), String> {
        let document = r#"
schema = 1

[[providers]]
id = "github"
kind = "github"
brand = "github"
display_name = "GitHub"
base_url = "https://github.com"
api_url = "https://api.github.com"
app_slug = "typst-collaboration"
client_id = "public-client"
redirect_uri = "https://collab.example.test/v1/external-git/providers/github/callback"
login_enabled = true

[[providers]]
id = "engineering-github"
kind = "github"
brand = "github"
display_name = "Engineering GitHub"
base_url = "https://github.engineering.example.test"
api_url = "https://github.engineering.example.test/api/v3"
app_slug = "typst-collaboration"
client_id = "engineering-client"
redirect_uri = "https://collab.example.test/v1/external-git/providers/engineering-github/callback"
login_enabled = false
"#;
        let values = HashMap::from([
            (
                "EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY",
                "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
            ),
            ("EXTERNAL_GIT_GITHUB_CLIENT_SECRET", "public-secret"),
            (
                "EXTERNAL_GIT_ENGINEERING_GITHUB_CLIENT_SECRET",
                "engineering-secret",
            ),
        ]);
        let registry = provider_registry_from_toml(document, &|name| {
            values.get(name).map(ToString::to_string)
        })?;

        assert_eq!(registry.len(), 2);
        assert_eq!(
            registry
                .get(&"github".parse().map_err(|_| "invalid test ID")?)
                .map(|provider| provider.kind()),
            Some(ProviderKind::GitHub)
        );
        assert_eq!(
            registry
                .get(&"github".parse().map_err(|_| "invalid test ID")?)
                .and_then(ExternalGitProvider::login)
                .map(|login| login.path)
                .as_deref(),
            Some("/v1/auth/external-git/github/login")
        );
        assert_eq!(
            registry
                .get(
                    &"engineering-github"
                        .parse()
                        .map_err(|_| "invalid test ID")?
                )
                .map(|provider| provider.display_name()),
            Some("Engineering GitHub")
        );
        Ok(())
    }

    #[test]
    fn registry_config_rejects_duplicate_instance_ids() {
        let document = r#"
schema = 1

[[providers]]
id = "github"
kind = "github"
brand = "github"
display_name = "GitHub One"
base_url = "https://github.com"
app_slug = "one"
client_id = "client-id"
redirect_uri = "https://collab.example.test/v1/external-git/providers/github/callback"
login_enabled = false

[[providers]]
id = "github"
kind = "github"
brand = "github"
display_name = "GitHub Two"
base_url = "https://github.example.test"
app_slug = "two"
client_id = "client-id"
redirect_uri = "https://collab.example.test/v1/external-git/providers/github/callback"
login_enabled = false
"#;
        let result = provider_registry_from_toml(document, &|name| match name {
            "EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY" => {
                Some("CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=".to_string())
            }
            _ => Some("configured".to_string()),
        });
        assert!(result.is_err_and(|error| error.contains("duplicate provider instance ID")));
    }

    #[test]
    fn registry_config_rejects_brand_adapter_mismatch() {
        let document = r#"
schema = 1

[[providers]]
id = "gitlab"
kind = "gitlab"
brand = "codeberg"
display_name = "GitLab"
base_url = "https://gitlab.example.test"
client_id = "client-id"
redirect_uri = "https://collab.example.test/v1/external-git/providers/gitlab/callback"
login_enabled = false
"#;

        assert!(provider_registry_from_toml(document, &|name| match name {
            "EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY" => {
                Some("CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=".to_string())
            }
            _ => None,
        })
        .is_err_and(|error| error.contains("brand 'codeberg' is not valid")));
    }

    #[test]
    fn registry_config_supports_multiple_gitlab_instances_with_independent_oauth_clients(
    ) -> Result<(), String> {
        let document = r#"
schema = 1

[[providers]]
id = "gitlab-com"
kind = "gitlab"
brand = "gitlab"
display_name = "GitLab.com"
base_url = "https://gitlab.com"
api_url = "https://gitlab.com/api/v4"
client_id = "gitlab-com-client"
redirect_uri = "https://collab.example.test/v1/external-git/providers/gitlab-com/callback"
login_enabled = true

[[providers]]
id = "engineering-gitlab"
kind = "gitlab"
brand = "gitlab"
display_name = "Engineering GitLab"
base_url = "https://gitlab.engineering.example.test"
api_url = "https://gitlab.engineering.example.test/api/v4"
client_id = "engineering-client"
redirect_uri = "https://collab.example.test/v1/external-git/providers/engineering-gitlab/callback"
login_enabled = false
"#;
        let values = HashMap::from([
            (
                "EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY",
                "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
            ),
            ("EXTERNAL_GIT_GITLAB_COM_CLIENT_SECRET", "gitlab-com-secret"),
            (
                "EXTERNAL_GIT_ENGINEERING_GITLAB_CLIENT_SECRET",
                "engineering-secret",
            ),
        ]);
        let registry = provider_registry_from_toml(document, &|name| {
            values.get(name).map(ToString::to_string)
        })?;

        assert_eq!(registry.len(), 2);
        let public = registry
            .get(&"gitlab-com".parse().map_err(|_| "invalid test ID")?)
            .ok_or("gitlab.com instance missing")?;
        let engineering = registry
            .get(
                &"engineering-gitlab"
                    .parse()
                    .map_err(|_| "invalid test ID")?,
            )
            .ok_or("engineering GitLab instance missing")?;

        assert_eq!(public.kind(), ProviderKind::GitLab);
        assert_eq!(engineering.kind(), ProviderKind::GitLab);
        assert_eq!(
            public.login().map(|login| login.path),
            Some("/v1/auth/external-git/gitlab-com/login".to_string())
        );
        assert_eq!(engineering.login().map(|login| login.path), None);
        let public_url = reqwest::Url::parse(
            &public
                .authorization_url("public-state")
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let engineering_url = reqwest::Url::parse(
            &engineering
                .authorization_url("engineering-state")
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(
            public_url
                .query_pairs()
                .find_map(|(key, value)| (key == "client_id").then(|| value.into_owned())),
            Some("gitlab-com-client".to_string())
        );
        assert_eq!(
            engineering_url
                .query_pairs()
                .find_map(|(key, value)| (key == "client_id").then(|| value.into_owned())),
            Some("engineering-client".to_string())
        );
        Ok(())
    }

    #[test]
    fn gitlab_provider_uses_one_callback_and_only_its_required_scopes() -> Result<(), String> {
        let callback = "https://collab.example.test/v1/external-git/providers/gitlab-com/callback";
        let document = format!(
            r#"
schema = 1

[[providers]]
id = "gitlab-com"
kind = "gitlab"
brand = "gitlab"
display_name = "GitLab.com"
base_url = "https://gitlab.com"
client_id = "client-id"
redirect_uri = "{callback}"
login_enabled = true
"#
        );
        let registry = provider_registry_from_toml(&document, &|name| match name {
            "EXTERNAL_GIT_GITLAB_COM_CLIENT_SECRET" => Some("client-secret".to_string()),
            "EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY" => {
                Some("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=".to_string())
            }
            _ => None,
        })?;
        let provider = registry
            .get(&"gitlab-com".parse().map_err(|_| "invalid test ID")?)
            .ok_or("GitLab provider missing")?;

        for url in [
            provider
                .authorization_url("connect-state")
                .map_err(|error| error.to_string())?,
            provider
                .login_authorization_url("login-state")
                .map_err(|error| error.to_string())?,
        ] {
            let url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
            assert_eq!(
                url.query_pairs()
                    .find_map(|(key, value)| (key == "redirect_uri").then(|| value.into_owned())),
                Some(callback.to_string())
            );
            assert_eq!(
                url.query_pairs()
                    .find_map(|(key, value)| (key == "scope").then(|| value.into_owned())),
                Some("api write_repository".to_string())
            );
        }
        Ok(())
    }

    #[test]
    fn registry_config_builds_a_codeberg_branded_forgejo_adapter() -> Result<(), String> {
        let document = r#"
schema = 1

[[providers]]
id = "codeberg"
kind = "forgejo"
brand = "codeberg"
display_name = "Codeberg"
base_url = "https://codeberg.org"
client_id = "codeberg-client"
redirect_uri = "https://collab.example.test/v1/external-git/providers/codeberg/callback"
login_enabled = true
"#;
        let registry = provider_registry_from_toml(document, &|name| match name {
            "EXTERNAL_GIT_CODEBERG_CLIENT_SECRET" => Some("codeberg-secret".to_string()),
            "EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY" => {
                Some("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=".to_string())
            }
            _ => None,
        })?;
        let provider = registry
            .get(&"codeberg".parse().map_err(|_| "invalid test ID")?)
            .ok_or("Codeberg provider missing")?;

        assert_eq!(provider.kind(), ProviderKind::Forgejo);
        assert_eq!(provider.brand(), ProviderBrand::Codeberg);
        assert!(provider.capabilities().repository_creation);
        let authorization_url = reqwest::Url::parse(
            &provider
                .authorization_url("forgejo-state")
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(authorization_url.path(), "/login/oauth/authorize");
        assert_eq!(
            authorization_url
                .query_pairs()
                .find_map(|(key, value)| (key == "client_id").then(|| value.into_owned())),
            Some("codeberg-client".to_string())
        );
        assert_eq!(
            authorization_url
                .query_pairs()
                .find_map(|(key, value)| (key == "scope").then(|| value.into_owned())),
            Some("openid profile email write:user write:repository write:organization".to_string())
        );
        Ok(())
    }

    #[test]
    fn registry_config_builds_a_gitea_dialect_on_the_forge_api_family() -> Result<(), String> {
        let document = r#"
schema = 1

[[providers]]
id = "gitea"
kind = "gitea"
brand = "gitea"
display_name = "Gitea"
base_url = "https://git.example.test"
client_id = "gitea-client"
redirect_uri = "https://collab.example.test/v1/external-git/providers/gitea/callback"
login_enabled = true
"#;
        let registry = provider_registry_from_toml(document, &|name| match name {
            "EXTERNAL_GIT_GITEA_CLIENT_SECRET" => Some("gitea-secret".to_string()),
            "EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY" => {
                Some("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=".to_string())
            }
            _ => None,
        })?;
        let provider = registry
            .get(&"gitea".parse().map_err(|_| "invalid test ID")?)
            .ok_or("Gitea provider missing")?;

        assert_eq!(provider.kind(), ProviderKind::Gitea);
        assert_eq!(provider.brand(), ProviderBrand::Gitea);
        assert!(provider.capabilities().repository_creation);
        let authorization_url = reqwest::Url::parse(
            &provider
                .authorization_url("gitea-state")
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(authorization_url.path(), "/login/oauth/authorize");
        assert_eq!(
            authorization_url
                .query_pairs()
                .find_map(|(key, value)| (key == "client_id").then(|| value.into_owned())),
            Some("gitea-client".to_string())
        );
        assert_eq!(
            authorization_url
                .query_pairs()
                .find_map(|(key, value)| (key == "scope").then(|| value.into_owned())),
            Some("openid profile email write:user write:repository write:organization".to_string())
        );
        Ok(())
    }
}
