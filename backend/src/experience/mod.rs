//! Runtime product identity, landing content, help, and resource discovery.

mod content;
mod http;
mod model;

pub(crate) use content::{Experience, HelpContent};
pub(crate) use http::{
    experience_config, help_content, product_favicon, product_touch_icon, spa_index,
};
pub(crate) use model::{ExperienceResourceKind, ExperienceVisibility};
