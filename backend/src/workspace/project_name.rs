//! Validated Workspace project names.

use thiserror::Error;

const MAX_PROJECT_NAME_CHARS: usize = 200;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProjectName(String);

impl ProjectName {
    pub(crate) fn parse(raw: &str) -> Result<Self, InvalidProjectName> {
        let value = raw.trim();
        if value.is_empty()
            || value.chars().count() > MAX_PROJECT_NAME_CHARS
            || value.chars().any(char::is_control)
        {
            return Err(InvalidProjectName);
        }
        Ok(Self(value.to_string()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("project name is invalid")]
pub(crate) struct InvalidProjectName;

#[cfg(test)]
mod tests {
    use super::{InvalidProjectName, ProjectName, MAX_PROJECT_NAME_CHARS};

    #[test]
    fn names_are_trimmed_once_at_the_boundary() -> Result<(), InvalidProjectName> {
        let name = ProjectName::parse("  Quarterly slides  ")?;

        assert_eq!(name.as_str(), "Quarterly slides");
        Ok(())
    }

    #[test]
    fn empty_control_and_oversized_names_are_rejected() {
        assert_eq!(ProjectName::parse(" \t "), Err(InvalidProjectName));
        assert_eq!(
            ProjectName::parse("slides\narchive"),
            Err(InvalidProjectName)
        );
        assert_eq!(
            ProjectName::parse(&"界".repeat(MAX_PROJECT_NAME_CHARS + 1)),
            Err(InvalidProjectName)
        );
    }

    #[test]
    fn maximum_length_is_measured_in_unicode_characters() -> Result<(), InvalidProjectName> {
        let value = "界".repeat(MAX_PROJECT_NAME_CHARS);
        let name = ProjectName::parse(&value)?;

        assert_eq!(name.as_str(), value);
        Ok(())
    }
}
