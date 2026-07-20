//! Canonical localized text shared by bounded-context read models.

#[derive(Clone, Debug, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct LocalizedText {
    pub en: String,
    #[serde(rename = "zh-CN")]
    pub zh_cn: String,
}
