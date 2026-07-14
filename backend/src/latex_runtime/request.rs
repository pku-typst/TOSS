use std::path::{Component, Path};
use thiserror::Error;

// TeX Live's kpse_file_format_type currently has 59 concrete values followed
// by kpse_last_format. BusyTeX sends the numeric enum value to its file server.
const KPATHSEA_FORMAT_COUNT: u8 = 59;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct TexliveRequest {
    pub(super) format: u8,
    pub(super) filename: String,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub(super) enum TexliveRequestError {
    #[error("invalid TeXLive request path")]
    InvalidPath,
    #[error("unsupported TeXLive request shape")]
    UnsupportedShape,
}

pub(super) fn parse_texlive_request(raw: &str) -> Result<TexliveRequest, TexliveRequestError> {
    // Axum's wildcard path extractor includes its leading slash. Strip that
    // transport delimiter exactly once; the remaining path must be canonical.
    let request_path = raw.strip_prefix('/').unwrap_or(raw);
    if raw.is_empty()
        || raw != raw.trim()
        || request_path.starts_with('/')
        || raw.len() > 2048
        || raw.contains('\\')
    {
        return Err(TexliveRequestError::InvalidPath);
    }
    let path = Path::new(request_path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(TexliveRequestError::InvalidPath);
    }
    let parts: Vec<&str> = request_path.split('/').collect();
    let (format, filename) = match parts.as_slice() {
        [format, filename] => {
            let format = format
                .parse::<u8>()
                .ok()
                .filter(|value| *value < KPATHSEA_FORMAT_COUNT)
                .ok_or(TexliveRequestError::UnsupportedShape)?;
            (format, *filename)
        }
        _ => return Err(TexliveRequestError::UnsupportedShape),
    };
    if !is_safe_filename(filename) {
        return Err(TexliveRequestError::UnsupportedShape);
    }
    Ok(TexliveRequest {
        format,
        filename: filename.to_string(),
    })
}

fn is_safe_filename(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 255
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::{parse_texlive_request, TexliveRequestError};

    #[test]
    fn requests_are_canonical_and_typed() -> Result<(), TexliveRequestError> {
        let request = parse_texlive_request("/26/geometry.sty")?;
        assert_eq!(request.filename, "geometry.sty");
        assert_eq!(request.format, 26);

        let font = parse_texlive_request("46/lmroman10-regular.otf")?;
        assert_eq!(font.format, 46);
        Ok(())
    }

    #[test]
    fn requests_reject_traversal_and_unknown_shapes() {
        assert_eq!(
            parse_texlive_request("../secret"),
            Err(TexliveRequestError::InvalidPath)
        );
        assert_eq!(
            parse_texlive_request("26/a\\b"),
            Err(TexliveRequestError::InvalidPath)
        );
        assert_eq!(
            parse_texlive_request("xetex/26/article.cls"),
            Err(TexliveRequestError::UnsupportedShape)
        );
        assert_eq!(
            parse_texlive_request("59/article.cls"),
            Err(TexliveRequestError::UnsupportedShape)
        );
        assert_eq!(
            parse_texlive_request("26/article\u{7f}.cls"),
            Err(TexliveRequestError::UnsupportedShape)
        );
        assert!(parse_texlive_request("26/article?.cls").is_ok());
        assert!(parse_texlive_request("26/a+b@c,1.sty").is_ok());
    }
}
