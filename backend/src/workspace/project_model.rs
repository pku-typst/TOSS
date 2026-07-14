//! Project values and catalog read contracts owned by Workspace.

use crate::access::ProjectRole;
use crate::text_enum::text_enum;
use chrono::{DateTime, Utc};
use uuid::Uuid;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ProjectType {
        Typst => "typst",
        Latex => "latex",
    }
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct Project {
    pub id: Uuid,
    pub name: String,
    pub project_type: ProjectType,
    #[schema(required)]
    pub latex_engine: Option<LatexEngine>,
    #[schema(required)]
    pub owner_user_id: Option<Uuid>,
    pub owner_display_name: String,
    pub my_role: ProjectRole,
    pub can_read: bool,
    pub is_template: bool,
    pub has_thumbnail: bool,
    pub created_at: DateTime<Utc>,
    pub last_edited_at: DateTime<Utc>,
    pub archived: bool,
    #[schema(required)]
    pub archived_at: Option<DateTime<Utc>>,
}

impl ProjectType {
    pub const fn default_entry_file_path(self) -> &'static str {
        match self {
            Self::Typst => "main.typ",
            Self::Latex => "main.tex",
        }
    }

    pub const fn default_latex_engine(self) -> Option<LatexEngine> {
        match self {
            Self::Typst => None,
            Self::Latex => Some(LatexEngine::Xetex),
        }
    }

    pub fn accepts_entry_file_path(self, path: &str) -> bool {
        let path = path.to_ascii_lowercase();
        match self {
            Self::Typst => path.ends_with(".typ"),
            Self::Latex => path.ends_with(".tex") || path.ends_with(".ltx"),
        }
    }

    pub fn choose_entry_file_path(
        self,
        current: &str,
        document_paths: &[String],
    ) -> Option<String> {
        let mut candidates = document_paths
            .iter()
            .filter(|path| self.accepts_entry_file_path(path))
            .cloned()
            .collect::<Vec<_>>();
        candidates.sort();
        if candidates.iter().any(|path| path == current) {
            return Some(current.to_string());
        }
        let preferred = match self {
            Self::Typst => ["main.typ", "slides.typ", "document.typ"],
            Self::Latex => ["main.tex", "paper.tex", "document.tex"],
        };
        preferred
            .into_iter()
            .find(|path| candidates.iter().any(|candidate| candidate == path))
            .map(str::to_string)
            .or_else(|| candidates.into_iter().next())
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum LatexEngine {
        Pdftex => "pdftex",
        Xetex => "xetex",
    }
}

#[cfg(test)]
mod tests {
    use super::ProjectType;

    #[test]
    fn project_types_define_their_entry_files() {
        assert_eq!(ProjectType::Typst.default_entry_file_path(), "main.typ");
        assert_eq!(ProjectType::Latex.default_entry_file_path(), "main.tex");
        assert_eq!(ProjectType::Typst.default_latex_engine(), None);
        assert_eq!(
            ProjectType::Latex.default_latex_engine(),
            Some(super::LatexEngine::Xetex)
        );
    }

    #[test]
    fn project_types_own_their_entry_file_policy() {
        assert!(ProjectType::Typst.accepts_entry_file_path("slides.typ"));
        assert!(!ProjectType::Typst.accepts_entry_file_path("slides.tex"));
        assert!(ProjectType::Latex.accepts_entry_file_path("slides.TEX"));
        assert!(ProjectType::Latex.accepts_entry_file_path("slides.ltx"));
        assert!(!ProjectType::Latex.accepts_entry_file_path("slides.typ"));
        let typst_paths = vec!["deck.typ".to_string(), "main.typ".to_string()];
        assert_eq!(
            ProjectType::Typst.choose_entry_file_path("missing.typ", &typst_paths),
            Some("main.typ".to_string())
        );
        assert_eq!(
            ProjectType::Typst.choose_entry_file_path("deck.typ", &typst_paths),
            Some("deck.typ".to_string())
        );
        assert_eq!(
            ProjectType::Typst.choose_entry_file_path("main.typ", &["README.md".to_string()]),
            None
        );
    }
}
