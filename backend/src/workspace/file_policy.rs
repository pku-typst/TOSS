#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidProjectPath;

pub(crate) fn sanitize_project_path(raw: &str) -> Result<String, InvalidProjectPath> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return Err(InvalidProjectPath);
    }
    let canonical = trimmed.replace('\\', "/");
    let mut parts = Vec::new();
    for segment in canonical.split('/') {
        let segment = segment.trim();
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.eq_ignore_ascii_case(".git")
            || segment.contains('\0')
        {
            return Err(InvalidProjectPath);
        }
        parts.push(segment);
    }
    if parts.is_empty() {
        return Err(InvalidProjectPath);
    }
    Ok(parts.join("/"))
}

pub(crate) fn path_is_in_subtree(path: &str, subtree: &str) -> bool {
    path == subtree
        || path
            .strip_prefix(subtree)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub(crate) fn move_path_with_subtree(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    path.strip_prefix(from)
        .filter(|suffix| suffix.starts_with('/'))
        .map(|suffix| format!("{to}{suffix}"))
}

pub(crate) fn is_document_text_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [
        ".typ", ".tex", ".ltx", ".sty", ".cls", ".bst", ".bib", ".txt", ".md", ".json", ".toml",
        ".yaml", ".yml", ".csv", ".xml", ".html", ".css", ".js", ".ts", ".tsx", ".jsx",
    ]
    .iter()
    .any(|extension| lower.ends_with(extension))
}

pub(crate) fn guess_content_type(path: &str) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

pub(crate) fn looks_like_text(bytes: &[u8]) -> bool {
    !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{
        guess_content_type, is_document_text_path, looks_like_text, move_path_with_subtree,
        path_is_in_subtree, sanitize_project_path,
    };

    #[test]
    fn project_paths_are_normalized_and_bounded() {
        assert_eq!(
            sanitize_project_path(" slides/main.typ "),
            Ok("slides/main.typ".to_string())
        );
        assert!(sanitize_project_path("../secret").is_err());
        assert!(sanitize_project_path("slides//main.typ").is_err());
        assert!(sanitize_project_path("/absolute.typ").is_err());
        assert!(sanitize_project_path(".git/config").is_err());
        assert!(sanitize_project_path("assets/.GIT/index").is_err());
    }

    #[test]
    fn subtree_paths_preserve_segment_boundaries() {
        assert!(path_is_in_subtree("slides/main.typ", "slides"));
        assert!(!path_is_in_subtree("slides-old/main.typ", "slides"));
        assert_eq!(
            move_path_with_subtree("slides/main.typ", "slides", "deck"),
            Some("deck/main.typ".to_string())
        );
        assert_eq!(
            move_path_with_subtree("slides-old/main.typ", "slides", "deck"),
            None
        );
    }

    #[test]
    fn project_file_classification_is_explicit() {
        assert!(is_document_text_path("slides/main.typ"));
        assert!(is_document_text_path("refs/library.BIB"));
        assert!(!is_document_text_path("figures/chart.png"));
        assert_eq!(guess_content_type("figure.svg"), "image/svg+xml");
        assert_eq!(guess_content_type("font.woff2"), "font/woff2");
        assert_eq!(
            guess_content_type("unknown.typst-asset"),
            "application/octet-stream"
        );
        assert!(looks_like_text("hello".as_bytes()));
        assert!(!looks_like_text(b"binary\0payload"));
    }
}
