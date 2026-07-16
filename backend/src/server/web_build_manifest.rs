//! Compatibility fence between runtime configuration and the compiled SPA.

use crate::distribution::{AiConnectionPolicyKind, DistributionConfig, FrontendFeature};
use crate::workspace::ProjectType;
use serde::Deserialize;
use std::path::Path;

const BUILD_MANIFEST_SCHEMA: u32 = 2;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AiRuntimeBuildManifest {
    pub(super) build_id: String,
    pub(super) entry_path: String,
    pub(super) connection_policy: AiConnectionPolicyKind,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WebBuildManifest {
    schema: u32,
    project_types: Vec<ProjectType>,
    frontend_features: Vec<FrontendFeature>,
    ai_runtime: Option<AiRuntimeBuildManifest>,
}

impl WebBuildManifest {
    pub(super) fn load(static_dir: &Path) -> Result<Self, String> {
        let path = static_dir.join("toss-build-manifest.json");
        let raw = std::fs::read_to_string(&path).map_err(|error| {
            format!(
                "web build manifest '{}' could not be read: {error}",
                path.display()
            )
        })?;
        let manifest: Self = serde_json::from_str(&raw).map_err(|error| {
            format!(
                "web build manifest '{}' is invalid: {error}",
                path.display()
            )
        })?;
        manifest.validate_shape()?;
        Ok(manifest)
    }

    pub(super) fn validate_runtime(
        &self,
        distribution: &DistributionConfig,
        enabled_frontend_features: &[FrontendFeature],
    ) -> Result<(), String> {
        for project_type in &distribution.project_types {
            if !self.project_types.contains(project_type) {
                return Err(format!(
                    "runtime distribution {} enables project type {project_type} omitted from the web build",
                    distribution.id
                ));
            }
        }
        for feature in &distribution.frontend_features.included {
            if !self.frontend_features.contains(feature) {
                return Err(format!(
                    "runtime distribution {} includes frontend feature {feature} omitted from the web build",
                    distribution.id
                ));
            }
        }
        for feature in enabled_frontend_features {
            if !self.frontend_features.contains(feature) {
                return Err(format!(
                    "deployment enables frontend feature {feature} omitted from the web build"
                ));
            }
        }
        if let Some(runtime) = self.ai_runtime.as_ref() {
            let configured_policy = distribution
                .ai_assistant
                .as_ref()
                .ok_or_else(|| {
                    "web build includes an AI Runtime but the distribution has no AI policy"
                        .to_string()
                })?
                .kind();
            if runtime.connection_policy != configured_policy {
                return Err(
                    "web build AI connection policy does not match the runtime distribution"
                        .to_string(),
                );
            }
        }
        Ok(())
    }

    pub(super) fn ai_runtime(&self) -> Option<&AiRuntimeBuildManifest> {
        self.ai_runtime.as_ref()
    }

    fn validate_shape(&self) -> Result<(), String> {
        if self.schema != BUILD_MANIFEST_SCHEMA {
            return Err(format!(
                "web build manifest schema {} is unsupported; expected {BUILD_MANIFEST_SCHEMA}",
                self.schema
            ));
        }
        if !self.project_types.contains(&ProjectType::Typst) {
            return Err("web build manifest must include project type typst".to_string());
        }
        if contains_duplicates(&self.project_types) {
            return Err("web build manifest project_types must not contain duplicates".to_string());
        }
        if contains_duplicates(&self.frontend_features) {
            return Err(
                "web build manifest frontend_features must not contain duplicates".to_string(),
            );
        }
        let includes_ai = self
            .frontend_features
            .contains(&FrontendFeature::AiAssistant);
        match (includes_ai, self.ai_runtime.as_ref()) {
            (true, Some(runtime)) => {
                if runtime.entry_path != "_ai-runtime/bootstrap.html" {
                    return Err(
                        "web build manifest AI Runtime entry path is unsupported".to_string()
                    );
                }
                if runtime.build_id.len() < 16
                    || runtime.build_id.len() > 128
                    || !runtime
                        .build_id
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
                {
                    return Err("web build manifest AI Runtime build ID is invalid".to_string());
                }
            }
            (true, None) => {
                return Err(
                    "web build manifest includes ai_assistant without an AI Runtime artifact"
                        .to_string(),
                )
            }
            (false, Some(_)) => {
                return Err(
                    "web build manifest contains an AI Runtime artifact without ai_assistant"
                        .to_string(),
                )
            }
            (false, None) => {}
        }
        Ok(())
    }
}

fn contains_duplicates<T: PartialEq>(values: &[T]) -> bool {
    values
        .iter()
        .enumerate()
        .any(|(index, value)| values.iter().skip(index + 1).any(|other| other == value))
}

#[cfg(test)]
mod tests {
    use super::WebBuildManifest;
    use crate::distribution::{DistributionConfig, FrontendFeature};

    #[test]
    fn runtime_cannot_enable_code_omitted_from_web_build() -> Result<(), String> {
        let manifest: WebBuildManifest = serde_json::from_str(
            r#"{"schema":2,"project_types":["typst"],"frontend_features":[],"ai_runtime":null}"#,
        )
        .map_err(|error| error.to_string())?;
        manifest.validate_shape()?;
        let mut distribution = DistributionConfig::default();
        distribution.project_types = vec![crate::workspace::ProjectType::Typst];
        distribution.frontend_features.included = vec![FrontendFeature::AiAssistant];
        distribution.ai_assistant = Some(crate::distribution::AiAssistantConfig::UserDefined);

        let error = manifest.validate_runtime(&distribution, &[]).err();

        assert!(error.is_some_and(|message| message.contains("omitted from the web build")));
        Ok(())
    }
}
