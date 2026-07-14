use thiserror::Error;

const MAX_SOURCE_BRANCH_BYTES: usize = 255;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SourceBranch(String);

impl SourceBranch {
    pub(super) fn parse(raw: &str) -> Result<Self, InvalidSourceBranch> {
        let value = raw.trim();
        if value.is_empty()
            || value.len() > MAX_SOURCE_BRANCH_BYTES
            || value.starts_with('-')
            || !matches!(git2::Branch::name_is_valid(value), Ok(true))
        {
            return Err(InvalidSourceBranch);
        }
        Ok(Self(value.to_string()))
    }

    pub(super) fn as_str(&self) -> &str {
        &self.0
    }

    pub(super) fn into_string(self) -> String {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("source branch is invalid")]
pub(super) struct InvalidSourceBranch;

#[cfg(test)]
mod tests {
    use super::{InvalidSourceBranch, SourceBranch};

    #[test]
    fn source_branches_are_trimmed_once_at_the_boundary() -> Result<(), InvalidSourceBranch> {
        let branch = SourceBranch::parse("  feature/slides  ")?;

        assert_eq!(branch.as_str(), "feature/slides");
        Ok(())
    }

    #[test]
    fn source_branches_follow_git_reference_rules_and_reject_option_injection() {
        assert_eq!(
            SourceBranch::parse("-upload-pack=evil"),
            Err(InvalidSourceBranch)
        );
        assert_eq!(
            SourceBranch::parse("feature..main"),
            Err(InvalidSourceBranch)
        );
        assert_eq!(
            SourceBranch::parse("refs/heads/main.lock"),
            Err(InvalidSourceBranch)
        );
        assert_eq!(SourceBranch::parse("foo/.bar"), Err(InvalidSourceBranch));
        assert_eq!(SourceBranch::parse("line\nbreak"), Err(InvalidSourceBranch));
    }
}
