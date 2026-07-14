use utoipa::openapi::path::{HttpMethod, ParameterBuilder, ParameterIn, PathItem};
use utoipa::openapi::schema::{Object, Type};
use utoipa::openapi::{Required, Schema};

pub(super) fn add_to(document: &mut utoipa::openapi::OpenApi) {
    add_path_parameters(document);
    add_operation_parameters(document);
}

fn add_path_parameters(document: &mut utoipa::openapi::OpenApi) {
    for (path, item) in &mut document.paths.paths {
        let parameters = path_parameter_names(path)
            .into_iter()
            .map(|name| {
                ParameterBuilder::new()
                    .name(name)
                    .parameter_in(ParameterIn::Path)
                    .required(Required::True)
                    .schema(Some(Schema::Object(Object::with_type(Type::String))))
                    .build()
            })
            .collect::<Vec<_>>();
        if !parameters.is_empty() {
            item.parameters = Some(parameters);
        }
    }
}

fn path_parameter_names(path: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut remaining = path;
    while let Some((_, after_open)) = remaining.split_once('{') {
        let Some((name, after_close)) = after_open.split_once('}') else {
            break;
        };
        names.push(name.to_string());
        remaining = after_close;
    }
    names
}

#[derive(Clone, Copy)]
enum ParameterKind {
    Boolean,
    Integer,
    String,
}

struct ParameterSpec {
    name: &'static str,
    location: ParameterIn,
    required: bool,
    kind: ParameterKind,
}

fn add_operation_parameters(document: &mut utoipa::openapi::OpenApi) {
    add_parameters(
        document,
        "/v1/auth/oidc/login",
        HttpMethod::Get,
        &[query("return_to", false, ParameterKind::String)],
    );
    add_parameters(
        document,
        "/v1/auth/gitlab/login",
        HttpMethod::Get,
        &[query("return_to", false, ParameterKind::String)],
    );
    for callback_path in ["/v1/auth/oidc/callback", "/v1/auth/gitlab/callback"] {
        add_parameters(
            document,
            callback_path,
            HttpMethod::Get,
            &[
                query("code", true, ParameterKind::String),
                query("state", false, ParameterKind::String),
            ],
        );
    }
    for path in [
        "/v1/external-git/providers/{provider_id}/owners",
        "/v1/external-git/providers/{provider_id}/repositories",
        "/v1/external-git/providers/{provider_id}/repositories/{repository_id}/branches",
        "/v1/projects/{project_id}/external-git/branches",
    ] {
        add_parameters(
            document,
            path,
            HttpMethod::Get,
            &[
                query("search", false, ParameterKind::String),
                query("page", false, ParameterKind::Integer),
                query("per_page", false, ParameterKind::Integer),
            ],
        );
    }
    add_parameters(
        document,
        "/v1/projects",
        HttpMethod::Get,
        &[
            query("include_archived", false, ParameterKind::Boolean),
            query("q", false, ParameterKind::String),
        ],
    );
    add_parameters(
        document,
        "/v1/projects/{project_id}/documents",
        HttpMethod::Get,
        &[
            query("path", false, ParameterKind::String),
            query("after_change_sequence", false, ParameterKind::Integer),
        ],
    );
    add_parameters(
        document,
        "/v1/projects/{project_id}/documents/by-path/{path}",
        HttpMethod::Put,
        &[header(
            "x-project-content-epoch",
            true,
            ParameterKind::Integer,
        )],
    );
    add_parameters(
        document,
        "/v1/projects/{project_id}/documents/{document_id}",
        HttpMethod::Put,
        &[header(
            "x-project-content-epoch",
            true,
            ParameterKind::Integer,
        )],
    );
    add_parameters(
        document,
        "/v1/projects/{project_id}/revisions",
        HttpMethod::Get,
        &[
            query("before", false, ParameterKind::String),
            query("limit", false, ParameterKind::Integer),
        ],
    );
    add_parameters(
        document,
        "/v1/projects/{project_id}/revisions/{revision_id}/documents",
        HttpMethod::Get,
        &[
            query("current_revision_id", false, ParameterKind::String),
            query("include_live_anchor", false, ParameterKind::Boolean),
        ],
    );
    add_parameters(
        document,
        "/v1/realtime/ws/{doc_id}",
        HttpMethod::Get,
        &[
            query("project_id", true, ParameterKind::String),
            query("user_id", false, ParameterKind::String),
            query("user_name", false, ParameterKind::String),
            query("session_token", false, ParameterKind::String),
            query("share_token", false, ParameterKind::String),
            query("guest_session", false, ParameterKind::String),
            query("collaboration_revision", true, ParameterKind::Integer),
        ],
    );
    add_parameters(
        document,
        "/v1/realtime/projects/{project_id}",
        HttpMethod::Get,
        &[
            query("user_id", false, ParameterKind::String),
            query("session_token", false, ParameterKind::String),
            query("share_token", false, ParameterKind::String),
            query("guest_session", false, ParameterKind::String),
        ],
    );
}

const fn query(name: &'static str, required: bool, kind: ParameterKind) -> ParameterSpec {
    ParameterSpec {
        name,
        location: ParameterIn::Query,
        required,
        kind,
    }
}

const fn header(name: &'static str, required: bool, kind: ParameterKind) -> ParameterSpec {
    ParameterSpec {
        name,
        location: ParameterIn::Header,
        required,
        kind,
    }
}

fn add_parameters(
    document: &mut utoipa::openapi::OpenApi,
    path: &str,
    method: HttpMethod,
    specs: &[ParameterSpec],
) {
    let Some(path_item) = document.paths.paths.get_mut(path) else {
        return;
    };
    let Some(operation) = operation_mut(path_item, method) else {
        return;
    };
    let parameters = operation.parameters.get_or_insert_with(Vec::new);
    parameters.extend(specs.iter().map(|spec| {
        let schema_type = match spec.kind {
            ParameterKind::Boolean => Type::Boolean,
            ParameterKind::Integer => Type::Integer,
            ParameterKind::String => Type::String,
        };
        ParameterBuilder::new()
            .name(spec.name)
            .parameter_in(spec.location.clone())
            .required(if spec.required {
                Required::True
            } else {
                Required::False
            })
            .schema(Some(Schema::Object(Object::with_type(schema_type))))
            .build()
    }));
}

fn operation_mut(
    item: &mut PathItem,
    method: HttpMethod,
) -> Option<&mut utoipa::openapi::path::Operation> {
    match method {
        HttpMethod::Delete => item.delete.as_mut(),
        HttpMethod::Get => item.get.as_mut(),
        HttpMethod::Head => item.head.as_mut(),
        HttpMethod::Options => item.options.as_mut(),
        HttpMethod::Patch => item.patch.as_mut(),
        HttpMethod::Post => item.post.as_mut(),
        HttpMethod::Put => item.put.as_mut(),
        HttpMethod::Trace => item.trace.as_mut(),
    }
}
