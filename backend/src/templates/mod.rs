//! Template discovery, publication, grants, and built-in instantiation.

mod builtin_http;
mod builtin_instantiation;
mod gallery_http;
mod gallery_listing;
mod gallery_model;
mod http_error;
mod organization_grants;
mod organization_grants_http;
mod publication;
mod publication_http;

pub(crate) use builtin_http::{
    create_project_from_builtin_template, get_builtin_template_thumbnail,
    CreateBuiltinTemplateProjectInput,
};
pub(crate) use gallery_http::{list_template_gallery, TemplateGalleryResponse};
pub(crate) use gallery_model::TemplateSource;
pub(crate) use organization_grants_http::{
    delete_project_template_organization_access, list_project_template_organization_access,
    upsert_project_template_organization_access,
};
pub(crate) use publication::TemplatePublication;
pub(crate) use publication_http::{update_project_template, UpdateProjectTemplateInput};
