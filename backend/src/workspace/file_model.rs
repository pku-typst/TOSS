//! File-tree values owned by Workspace.

use crate::text_enum::text_enum;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ProjectFileKind {
        File => "file",
        Directory => "directory",
    }
}
