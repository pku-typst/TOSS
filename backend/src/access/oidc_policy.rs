use openidconnect::IssuerUrl;

pub(crate) fn safe_return_path(input: &str) -> Option<&str> {
    let value = input.trim();
    if value.is_empty()
        || value.len() > 2048
        || !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        None
    } else {
        Some(value)
    }
}

pub(crate) fn discovery_issuer(input: &str) -> Result<IssuerUrl, openidconnect::url::ParseError> {
    let trimmed = input.trim();
    let issuer = trimmed
        .strip_suffix("/.well-known/openid-configuration")
        .unwrap_or(trimmed);
    IssuerUrl::new(issuer.to_string())
}

#[cfg(test)]
mod tests {
    use super::safe_return_path;

    #[test]
    fn oidc_return_path_stays_on_the_application_origin() {
        assert_eq!(
            safe_return_path("/project/abc?panel=settings"),
            Some("/project/abc?panel=settings")
        );
        assert_eq!(safe_return_path("//evil.example.com"), None);
        assert_eq!(safe_return_path("https://evil.example.com"), None);
        assert_eq!(safe_return_path("/\\evil.example.com"), None);
        assert_eq!(
            safe_return_path("/project/abc\r\nlocation: https://evil.example.com"),
            None
        );
    }
}
