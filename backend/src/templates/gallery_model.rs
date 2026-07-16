//! Template gallery values owned by Templates.

use crate::text_enum::text_enum;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum TemplateSource {
        Builtin => "builtin",
        Personal => "personal",
        Shared => "shared",
    }
}
