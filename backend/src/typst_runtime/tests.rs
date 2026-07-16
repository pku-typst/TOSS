use super::archive::{archive_path_is_safe, validate_archive_contents};
use super::catalog::{sanitize_builtin_asset_path, TypstCatalog, CATALOG_SCHEMA};
use super::package::{PackageLimits, PackageSpec};
use super::universe::{
    DEFAULT_MAX_ARCHIVE_BYTES, DEFAULT_MAX_EXTRACTED_BYTES, DEFAULT_MAX_FILES,
    DEFAULT_MAX_FILE_BYTES,
};
use flate2::write::GzEncoder;
use flate2::Compression;
use std::error::Error;
use std::io::Read;
use std::path::{Path, PathBuf};
use tar::{Builder, Header};

fn test_limits() -> PackageLimits {
    PackageLimits {
        max_archive_bytes: DEFAULT_MAX_ARCHIVE_BYTES,
        max_extracted_bytes: DEFAULT_MAX_EXTRACTED_BYTES,
        max_file_bytes: DEFAULT_MAX_FILE_BYTES,
        max_files: DEFAULT_MAX_FILES,
    }
}

fn append_file(
    builder: &mut Builder<GzEncoder<Vec<u8>>>,
    path: &str,
    bytes: &[u8],
) -> Result<(), Box<dyn Error>> {
    let mut header = Header::new_gnu();
    header.set_size(u64::try_from(bytes.len())?);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, path, bytes)?;
    Ok(())
}

fn package_archive(name: &str, version: &str) -> Result<Vec<u8>, Box<dyn Error>> {
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = Builder::new(encoder);
    let manifest = format!(
        "[package]\nname = \"{name}\"\nversion = \"{version}\"\nentrypoint = \"lib.typ\"\n"
    );
    append_file(&mut builder, "typst.toml", manifest.as_bytes())?;
    append_file(&mut builder, "lib.typ", b"#let answer = 42\n")?;
    let encoder = builder.into_inner()?;
    Ok(encoder.finish()?)
}

#[test]
fn package_specs_are_strict() {
    assert!(PackageSpec::parse(
        "preview".to_string(),
        "cetz-plot".to_string(),
        "0.1.3".to_string()
    )
    .is_some());
    assert!(PackageSpec::parse(
        "local".to_string(),
        "fixture".to_string(),
        "0.6.0".to_string()
    )
    .is_none());
    assert!(PackageSpec::parse(
        "preview".to_string(),
        "../cetz".to_string(),
        "0.4.2".to_string()
    )
    .is_none());
    assert!(PackageSpec::parse(
        "preview".to_string(),
        "cetz".to_string(),
        "latest".to_string()
    )
    .is_none());
}

#[test]
fn package_archive_matches_requested_manifest() -> Result<(), Box<dyn Error>> {
    let bytes = package_archive("fixture", "1.2.3")?;
    let spec = PackageSpec::parse(
        "preview".to_string(),
        "fixture".to_string(),
        "1.2.3".to_string(),
    );
    let Some(spec) = spec else {
        return Err("fixture package spec should be valid".into());
    };
    assert!(validate_archive_contents(&bytes, &spec, test_limits()).is_ok());
    let wrong = PackageSpec::parse(
        "preview".to_string(),
        "other".to_string(),
        "1.2.3".to_string(),
    );
    let Some(wrong) = wrong else {
        return Err("mismatched package spec should still be syntactically valid".into());
    };
    assert!(validate_archive_contents(&bytes, &wrong, test_limits()).is_err());
    Ok(())
}

#[test]
fn package_archive_entry_count_is_bounded() -> Result<(), Box<dyn Error>> {
    let bytes = package_archive("fixture", "1.2.3")?;
    let spec = PackageSpec::parse(
        "preview".to_string(),
        "fixture".to_string(),
        "1.2.3".to_string(),
    );
    let Some(spec) = spec else {
        return Err("fixture package spec should be valid".into());
    };
    let mut limits = test_limits();
    limits.max_files = 1;
    assert!(validate_archive_contents(&bytes, &spec, limits).is_err());
    Ok(())
}

#[test]
fn archive_paths_reject_traversal() {
    assert!(archive_path_is_safe(Path::new("typst.toml")));
    assert!(archive_path_is_safe(Path::new("src/lib.typ")));
    assert!(!archive_path_is_safe(Path::new("../secret")));
    assert!(!archive_path_is_safe(Path::new("/etc/passwd")));
    assert!(!archive_path_is_safe(Path::new("src/../secret")));
}

#[test]
fn built_in_paths_stay_below_root() {
    let root = Path::new("/srv/typst");
    assert_eq!(
        sanitize_builtin_asset_path(root, "packages/preview/fixture-0.6.0.tar.gz"),
        Some(PathBuf::from(
            "/srv/typst/packages/preview/fixture-0.6.0.tar.gz"
        ))
    );
    assert_eq!(sanitize_builtin_asset_path(root, "../secret"), None);
    assert_eq!(sanitize_builtin_asset_path(root, "/etc/passwd"), None);
}

#[test]
fn test_archive_builder_finishes_cleanly() -> Result<(), Box<dyn Error>> {
    let bytes = package_archive("fixture", "0.1.0")?;
    let mut decoder = flate2::read::GzDecoder::new(bytes.as_slice());
    let mut decoded = Vec::new();
    decoder.read_to_end(&mut decoded)?;
    assert!(!decoded.is_empty());
    Ok(())
}

#[test]
fn community_catalog_is_a_valid_empty_fallback() -> Result<(), Box<dyn Error>> {
    let builtin_root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../distributions/community/typst");
    let catalog: TypstCatalog =
        serde_json::from_slice(&std::fs::read(builtin_root.join("catalog.json"))?)?;
    assert_eq!(catalog.schema, CATALOG_SCHEMA);
    assert!(catalog.universe_seeds.is_empty());
    Ok(())
}
