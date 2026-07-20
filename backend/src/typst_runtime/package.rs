use semver::Version;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PackageSpec {
    pub(super) namespace: String,
    pub(super) name: String,
    pub(super) version: String,
}

impl PackageSpec {
    pub(crate) fn parse(namespace: String, name: String, version: String) -> Option<Self> {
        if !matches!(namespace.as_str(), "local" | "preview") || !valid_package_name(&name) {
            return None;
        }
        let parsed = Version::parse(&version).ok()?;
        if parsed.to_string() != version {
            return None;
        }
        Some(Self {
            namespace,
            name,
            version,
        })
    }

    pub(super) fn key(&self) -> String {
        format!("{}/{}/{}", self.namespace, self.name, self.version)
    }

    pub(super) fn is_local(&self) -> bool {
        self.namespace == "local"
    }

    pub(crate) fn namespace(&self) -> &str {
        &self.namespace
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn version(&self) -> &str {
        &self.version
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TypstPackageRequirement {
    namespace: String,
    name: String,
    allowed_versions: Vec<String>,
}

impl TypstPackageRequirement {
    pub(crate) fn parse(
        namespace: String,
        name: String,
        allowed_versions: Vec<String>,
    ) -> Option<Self> {
        let validation_version = allowed_versions
            .first()
            .cloned()
            .unwrap_or_else(|| "0.0.0".to_string());
        PackageSpec::parse(namespace.clone(), name.clone(), validation_version)?;
        let mut normalized_versions = Vec::with_capacity(allowed_versions.len());
        for version in allowed_versions {
            let parsed = Version::parse(&version).ok()?;
            if parsed.to_string() != version || !normalized_versions.insert_sorted_unique(version) {
                return None;
            }
        }
        Some(Self {
            namespace,
            name,
            allowed_versions: normalized_versions,
        })
    }

    pub(crate) fn matches(&self, package: &PackageSpec) -> bool {
        self.namespace == package.namespace()
            && self.name == package.name()
            && (self.allowed_versions.is_empty()
                || self
                    .allowed_versions
                    .iter()
                    .any(|version| version == package.version()))
    }
}

trait InsertSortedUnique {
    fn insert_sorted_unique(&mut self, value: String) -> bool;
}

impl InsertSortedUnique for Vec<String> {
    fn insert_sorted_unique(&mut self, value: String) -> bool {
        match self.binary_search(&value) {
            Ok(_) => false,
            Err(index) => {
                self.insert(index, value);
                true
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct PackageLimits {
    pub(super) max_archive_bytes: u64,
    pub(super) max_extracted_bytes: u64,
    pub(super) max_file_bytes: u64,
    pub(super) max_files: u64,
}

pub(super) struct PackagePayload {
    pub(super) bytes: Vec<u8>,
    pub(super) sha256: String,
    pub(super) cache_status: &'static str,
}

fn valid_package_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    let mut last = first;
    for value in chars {
        if !value.is_ascii_lowercase() && !value.is_ascii_digit() && value != '-' {
            return false;
        }
        last = value;
    }
    last.is_ascii_lowercase() || last.is_ascii_digit()
}
