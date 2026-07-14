use super::ApiErrorResponse;
use crate::server::HealthResponse;

json_operation!(health, get, "/health", "runtime", 200, HealthResponse);
binary_operation!(
    typst_package,
    get,
    "/v1/typst/packages/{namespace}/{name}/{version}",
    "runtime",
    "application/octet-stream"
);
binary_operation!(
    typst_builtin,
    get,
    "/v1/typst/builtin/{path}",
    "runtime",
    "application/octet-stream"
);
binary_operation!(
    latex_texlive,
    get,
    "/v1/latex/texlive/{path}",
    "runtime",
    "application/octet-stream"
);
