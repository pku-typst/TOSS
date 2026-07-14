use semver::Version;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PackageSpec {
    pub(super) namespace: String,
    pub(super) name: String,
    pub(super) version: String,
}

impl PackageSpec {
    pub(super) fn parse(namespace: String, name: String, version: String) -> Option<Self> {
        if namespace != "preview" || !valid_package_name(&name) {
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
