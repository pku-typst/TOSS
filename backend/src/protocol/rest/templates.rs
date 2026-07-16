use super::ApiErrorResponse;
use crate::access::TemplateOrganizationGrant;
use crate::templates::{
    CreateBuiltinTemplateProjectInput, TemplateGalleryResponse, TemplatePublication,
    UpdateProjectTemplateInput,
};
use crate::workspace::Project;

json_operation!(
    list_template_gallery,
    get,
    "/v1/templates",
    "templates",
    200,
    TemplateGalleryResponse
);
binary_operation!(
    builtin_template_thumbnail,
    get,
    "/v1/templates/builtin/{template_id}/thumbnail",
    "templates",
    "image/*"
);
json_operation!(
    create_from_builtin_template,
    post,
    "/v1/templates/builtin/{template_id}/projects",
    "templates",
    CreateBuiltinTemplateProjectInput,
    200,
    Project
);

json_operation!(
    update_project_template,
    put,
    "/v1/projects/{project_id}/template",
    "templates",
    UpdateProjectTemplateInput,
    200,
    TemplatePublication
);
json_array_operation!(
    list_template_organization_access,
    get,
    "/v1/projects/{project_id}/template-organization-access",
    "templates",
    200,
    TemplateOrganizationGrant
);
json_operation!(
    upsert_template_organization_access,
    put,
    "/v1/projects/{project_id}/template-organization-access/{org_id}",
    "templates",
    200,
    TemplateOrganizationGrant
);
empty_operation!(
    delete_template_organization_access,
    delete,
    "/v1/projects/{project_id}/template-organization-access/{org_id}",
    "templates",
    204
);
