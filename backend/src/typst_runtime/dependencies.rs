//! Static Typst package discovery for project applicability and input capture.

use super::PackageSpec;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;
use typst_syntax::ast::{Expr, ModuleImport, ModuleInclude};
use typst_syntax::package::PackageSpec as SyntaxPackageSpec;
use typst_syntax::SyntaxNode;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct TypstProjectDependencies {
    pub packages: HashSet<PackageSpec>,
    pub has_dynamic_imports: bool,
}

pub(crate) fn analyze_project_dependencies(
    entry_file_path: &str,
    documents: &HashMap<String, String>,
) -> TypstProjectDependencies {
    let mut dependencies = TypstProjectDependencies::default();
    let mut pending = VecDeque::from([entry_file_path.to_string()]);
    let mut visited = HashSet::new();
    while let Some(path) = pending.pop_front() {
        if !visited.insert(path.clone()) {
            continue;
        }
        let Some(source) = documents.get(&path) else {
            continue;
        };
        let root = typst_syntax::parse(source);
        visit_imports(&root, &path, documents, &mut dependencies, &mut pending);
    }
    dependencies
}

fn visit_imports(
    node: &SyntaxNode,
    current_path: &str,
    documents: &HashMap<String, String>,
    dependencies: &mut TypstProjectDependencies,
    pending: &mut VecDeque<String>,
) {
    let source = node
        .cast::<ModuleImport>()
        .map(ModuleImport::source)
        .or_else(|| node.cast::<ModuleInclude>().map(ModuleInclude::source));
    if let Some(source) = source {
        match source {
            Expr::Str(value) => {
                let value = value.get();
                if value.starts_with('@') {
                    if let Some(package) = parse_package_spec(value.as_str()) {
                        dependencies.packages.insert(package);
                    } else {
                        dependencies.has_dynamic_imports = true;
                    }
                } else if let Some(path) = resolve_project_import(current_path, value.as_str()) {
                    if documents.contains_key(&path) {
                        pending.push_back(path);
                    }
                }
            }
            _ => dependencies.has_dynamic_imports = true,
        }
    }
    for child in node.children() {
        visit_imports(child, current_path, documents, dependencies, pending);
    }
}

fn parse_package_spec(value: &str) -> Option<PackageSpec> {
    let parsed = SyntaxPackageSpec::from_str(value).ok()?;
    PackageSpec::parse(
        parsed.namespace.to_string(),
        parsed.name.to_string(),
        parsed.version.to_string(),
    )
}

fn resolve_project_import(current_path: &str, imported: &str) -> Option<String> {
    if imported.is_empty() || imported.contains('\\') || imported.chars().any(char::is_control) {
        return None;
    }
    let imported = Path::new(imported);
    let candidate = if imported.is_absolute() {
        imported.strip_prefix("/").ok()?.to_path_buf()
    } else {
        Path::new(current_path)
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(imported)
    };
    normalize_relative_path(&candidate)
}

fn normalize_relative_path(path: &Path) -> Option<String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let value = normalized.to_str()?;
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_reachable_local_imports_and_collects_exact_packages() {
        let documents = HashMap::from([
            (
                "main.typ".to_string(),
                "#import \"lib/slides.typ\": *\n#show: deck".to_string(),
            ),
            (
                "lib/slides.typ".to_string(),
                "#import \"@local/slides:0.7.0\": *".to_string(),
            ),
            (
                "unused.typ".to_string(),
                "#import \"@preview/unused:1.0.0\": *".to_string(),
            ),
        ]);

        let dependencies = analyze_project_dependencies("main.typ", &documents);

        assert_eq!(dependencies.packages.len(), 1);
        assert!(dependencies.packages.iter().any(|package| {
            package.namespace() == "local"
                && package.name() == "slides"
                && package.version() == "0.7.0"
        }));
        assert!(!dependencies.has_dynamic_imports);
    }

    #[test]
    fn rejects_project_escape_and_marks_dynamic_imports() {
        let documents = HashMap::from([(
            "nested/main.typ".to_string(),
            "#include \"../../outside.typ\"\n#let module = \"lib.typ\"\n#import module".to_string(),
        )]);

        let dependencies = analyze_project_dependencies("nested/main.typ", &documents);

        assert!(dependencies.packages.is_empty());
        assert!(dependencies.has_dynamic_imports);
    }
}
