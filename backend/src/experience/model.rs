//! Product-experience values shared by distribution loading and HTTP projections.

use crate::text_enum::text_enum;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExperienceResourceKind {
        Documentation => "documentation",
        Packages => "packages",
        Repository => "repository",
        Support => "support",
        Status => "status",
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExperienceVisibility {
        Public => "public",
        Authenticated => "authenticated",
    }
}
