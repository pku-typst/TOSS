//! Strict composition of optional deployment topology from one TOML document.

use crate::distribution::{DistributionConfig, FrontendFeature};
use crate::document_processing::{ProcessingConfig, ProcessingConfigFile};
use crate::external_repositories::{
    external_git_provider_registry_from_config, ExternalGitConfigFile, ExternalGitProviderRegistry,
};
use serde::Deserialize;
use std::env;
use std::path::{Path, PathBuf};

const DEPLOYMENT_SCHEMA_VERSION: u32 = 1;

pub(crate) struct DeploymentConfig {
    pub frontend_features: Vec<FrontendFeature>,
    pub external_git_providers: ExternalGitProviderRegistry,
    pub processing: ProcessingConfig,
    source_path: Option<PathBuf>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FrontendDeploymentFile {
    #[serde(default)]
    enabled_features: Option<Vec<FrontendFeature>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeploymentFile {
    schema: u32,
    #[serde(default)]
    frontend: FrontendDeploymentFile,
    #[serde(default)]
    external_git: ExternalGitConfigFile,
    #[serde(default)]
    document_processing: ProcessingConfigFile,
}

impl Default for DeploymentFile {
    fn default() -> Self {
        Self {
            schema: DEPLOYMENT_SCHEMA_VERSION,
            frontend: FrontendDeploymentFile::default(),
            external_git: ExternalGitConfigFile::default(),
            document_processing: ProcessingConfigFile::default(),
        }
    }
}

impl DeploymentConfig {
    pub(crate) fn load_from_env(distribution: &DistributionConfig) -> Result<Self, String> {
        let configured_path = match env::var("TOSS_DEPLOYMENT_CONFIG") {
            Ok(value) => {
                let value = value.trim();
                if value.is_empty() {
                    return Err("TOSS_DEPLOYMENT_CONFIG must not be empty".to_string());
                }
                Some(PathBuf::from(value))
            }
            Err(env::VarError::NotPresent) => None,
            Err(env::VarError::NotUnicode(_)) => {
                return Err("TOSS_DEPLOYMENT_CONFIG must be valid Unicode".to_string())
            }
        };
        Self::load(configured_path.as_deref(), distribution, &|name| {
            env::var(name).ok()
        })
    }

    fn load(
        path: Option<&Path>,
        distribution: &DistributionConfig,
        environment: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let (file, config_root, source_path) = match path {
            Some(path) => {
                let raw = std::fs::read_to_string(path).map_err(|error| {
                    format!(
                        "deployment config '{}' could not be read: {error}",
                        path.display()
                    )
                })?;
                let file: DeploymentFile = toml::from_str(&raw).map_err(|error| {
                    format!("deployment config '{}' is invalid: {error}", path.display())
                })?;
                let config_root = path
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .to_path_buf();
                (file, config_root, Some(path.to_path_buf()))
            }
            None => (DeploymentFile::default(), PathBuf::from("."), None),
        };
        if file.schema != DEPLOYMENT_SCHEMA_VERSION {
            return Err(format!(
                "deployment config schema {} is unsupported; expected {DEPLOYMENT_SCHEMA_VERSION}",
                file.schema
            ));
        }

        let frontend_features = validate_frontend_features(
            file.frontend
                .enabled_features
                .unwrap_or_else(|| distribution.frontend_features.default_enabled.clone()),
            distribution,
        )?;
        let external_git_providers =
            external_git_provider_registry_from_config(file.external_git, environment)?;
        let processing = ProcessingConfig::from_config(file.document_processing, &config_root)?;
        for operation in processing.configured_operations() {
            if !distribution.supports_processing_operation(operation) {
                return Err(format!(
                    "document processing operation {operation} is configured by the deployment but not allowed by distribution {}",
                    distribution.id
                ));
            }
        }

        Ok(Self {
            frontend_features,
            external_git_providers,
            processing,
            source_path,
        })
    }

    pub(crate) fn source_label(&self) -> String {
        self.source_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "built-in deployment defaults".to_string())
    }
}

fn validate_frontend_features(
    configured: Vec<FrontendFeature>,
    distribution: &DistributionConfig,
) -> Result<Vec<FrontendFeature>, String> {
    let mut normalized = Vec::with_capacity(configured.len());
    for feature in configured {
        if normalized.contains(&feature) {
            return Err("frontend.enabled_features must not contain duplicates".to_string());
        }
        if !distribution.includes_frontend_feature(feature) {
            return Err(format!(
                "frontend feature {feature} is enabled by the deployment but not included by distribution {}",
                distribution.id
            ));
        }
        normalized.push(feature);
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::DeploymentConfig;
    use crate::distribution::{DistributionConfig, FrontendFeature};
    use std::path::Path;

    #[test]
    fn checked_in_community_deployment_is_runnable() -> Result<(), Box<dyn std::error::Error>> {
        let repository_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("backend must have a repository parent")?;
        let distribution =
            DistributionConfig::load(&repository_root.join("distributions/community/toss.json"))?;

        let deployment = DeploymentConfig::load(
            Some(&repository_root.join("config/deployment.toml")),
            &distribution,
            &|_| None,
        )?;

        assert!(deployment.frontend_features.is_empty());
        assert!(deployment.processing.configured_operations().is_empty());
        assert_eq!(deployment.external_git_providers.len(), 0);
        Ok(())
    }

    #[test]
    fn absent_deployment_uses_distribution_frontend_defaults(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut distribution = DistributionConfig::default();
        distribution.frontend_features.included = vec![FrontendFeature::AiAssistant];
        distribution.frontend_features.default_enabled = vec![FrontendFeature::AiAssistant];

        let deployment = DeploymentConfig::load(None, &distribution, &|_| None)?;

        assert_eq!(deployment.frontend_features, [FrontendFeature::AiAssistant]);
        assert!(deployment.processing.configured_operations().is_empty());
        Ok(())
    }

    #[test]
    fn one_toml_composes_independent_deployment_sections() -> Result<(), Box<dyn std::error::Error>>
    {
        let directory = tempfile::tempdir()?;
        std::fs::write(
            directory.path().join("worker.token"),
            "01234567890123456789012345678901",
        )?;
        let path = directory.path().join("deployment.toml");
        std::fs::write(
            &path,
            r#"
schema = 1

[frontend]
enabled_features = ["ai_assistant"]

[[external_git.providers]]
id = "gitlab"
kind = "gitlab"
brand = "gitlab"
display_name = "GitLab"
base_url = "https://gitlab.example.test"
client_id = "public-client-id"
redirect_uri = "https://collab.example.test/v1/external-git/providers/gitlab/callback"
login_enabled = true

[[document_processing.worker_identities]]
id = "latex"
token_file = "worker.token"

[[document_processing.worker_identities.operations]]
id = "latex.compile.pdf/v1"
processor_contracts = ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
"#,
        )?;
        let mut distribution = DistributionConfig::default();
        distribution.frontend_features.included = vec![FrontendFeature::AiAssistant];
        let deployment = DeploymentConfig::load(Some(&path), &distribution, &|name| match name {
            "EXTERNAL_GIT_GITLAB_CLIENT_SECRET" => Some("client-secret".to_string()),
            "EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY" => {
                Some("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=".to_string())
            }
            _ => None,
        })?;

        assert_eq!(deployment.frontend_features, [FrontendFeature::AiAssistant]);
        assert_eq!(deployment.external_git_providers.len(), 1);
        assert_eq!(
            deployment.processing.configured_operations(),
            [crate::document_processing::ProcessingOperation::LatexCompilePdfV1]
        );
        Ok(())
    }

    #[test]
    fn deployment_cannot_enable_a_frontend_feature_missing_from_distribution(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("deployment.toml");
        std::fs::write(
            &path,
            r#"
schema = 1

[frontend]
enabled_features = ["ai_assistant"]
"#,
        )?;

        let error =
            DeploymentConfig::load(Some(&path), &DistributionConfig::default(), &|_| None).err();

        assert!(error.is_some_and(|message| message.contains("not included by distribution")));
        Ok(())
    }

    #[test]
    fn deployment_cannot_configure_an_operation_disallowed_by_distribution(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        std::fs::write(
            directory.path().join("worker.token"),
            "01234567890123456789012345678901",
        )?;
        let path = directory.path().join("deployment.toml");
        std::fs::write(
            &path,
            r#"
schema = 1

[[document_processing.worker_identities]]
id = "pptx"
token_file = "worker.token"

[[document_processing.worker_identities.operations]]
id = "typst.export.pptx/v1"
processor_contracts = ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
"#,
        )?;

        let error =
            DeploymentConfig::load(Some(&path), &DistributionConfig::default(), &|_| None).err();

        assert!(error.is_some_and(|message| message.contains("not allowed by distribution")));
        Ok(())
    }
}
