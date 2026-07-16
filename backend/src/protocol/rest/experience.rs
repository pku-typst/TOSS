use super::ApiErrorResponse;
use crate::experience::{Experience, HelpContent};

json_operation!(
    experience,
    get,
    "/v1/experience",
    "experience",
    200,
    Experience
);
json_operation!(help, get, "/v1/help", "experience", 200, HelpContent);
binary_operation!(
    product_favicon,
    get,
    "/v1/product-assets/favicon",
    "experience",
    "image/*"
);
binary_operation!(
    product_touch_icon,
    get,
    "/v1/product-assets/touch-icon",
    "experience",
    "image/*"
);
