use crate::text_enum::text_enum;
use crate::workspace::{
    guess_content_type, is_document_text_path, sanitize_project_path, ProjectFileKind,
};
use git2::{Commit, Oid, Repository, TreeWalkMode, TreeWalkResult};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum RevisionTransferMode {
        Full => "full",
        Delta => "delta",
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum RevisionBaseAnchor {
        None => "none",
        Live => "live",
        Revision => "revision",
    }
}

#[derive(Debug, Error)]
pub(crate) enum RevisionTransferError {
    #[error("revision ID is invalid")]
    InvalidRevisionId {
        #[source]
        source: git2::Error,
    },
    #[error("revision {revision_id} was not found")]
    RevisionNotFound {
        revision_id: String,
        #[source]
        source: git2::Error,
    },
    #[error("revision repository operation failed")]
    Git {
        #[source]
        source: git2::Error,
    },
    #[error("revision contains an invalid project path: {path}")]
    InvalidPath { path: String },
    #[error("revision document is not valid UTF-8: {path}")]
    InvalidDocumentEncoding {
        path: String,
        #[source]
        source: std::string::FromUtf8Error,
    },
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct RevisionFileNode {
    pub path: String,
    pub kind: ProjectFileKind,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct RevisionDocument {
    pub path: String,
    pub content: String,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct RevisionAsset {
    pub path: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub content_base64: String,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct RevisionTransfer {
    pub revision_id: String,
    pub entry_file_path: String,
    pub transfer_mode: RevisionTransferMode,
    pub base_anchor: RevisionBaseAnchor,
    #[schema(required)]
    pub base_revision_id: Option<String>,
    pub nodes: Vec<RevisionFileNode>,
    pub documents: Vec<RevisionDocument>,
    pub deleted_documents: Vec<String>,
    pub assets: Vec<RevisionAsset>,
    pub deleted_assets: Vec<String>,
}

#[derive(Clone)]
enum RevisionAnchorKind {
    None,
    Live,
    Revision(String),
}

#[derive(Clone)]
enum CommitPathKind {
    Document,
    Asset,
}

#[derive(Clone)]
struct CommitPathMeta {
    kind: CommitPathKind,
    content_type: String,
    size_bytes: i64,
}

#[derive(Clone, Default)]
struct CommitManifest {
    files: HashMap<String, CommitPathMeta>,
    directories: HashSet<String>,
}

#[derive(Clone)]
struct RevisionTransferCandidate {
    transfer_mode: RevisionTransferMode,
    anchor_kind: RevisionAnchorKind,
    document_paths: Vec<String>,
    deleted_documents: Vec<String>,
    asset_paths: Vec<String>,
    deleted_assets: Vec<String>,
    estimated_bytes: usize,
}

pub(crate) struct PreparedRevisionTransfer {
    target_manifest: CommitManifest,
    nodes: Vec<RevisionFileNode>,
    candidates: Vec<RevisionTransferCandidate>,
    live_base_context: Option<(CommitManifest, HashSet<String>)>,
}

fn estimate_asset_b64_bytes(size_bytes: i64) -> usize {
    let size = usize::try_from(size_bytes.max(0)).unwrap_or(0);
    size.div_ceil(3) * 4
}

fn load_commit_manifest(commit: &Commit<'_>) -> Result<CommitManifest, RevisionTransferError> {
    let tree = commit
        .tree()
        .map_err(|source| RevisionTransferError::Git { source })?;
    let mut manifest = CommitManifest::default();
    let mut invalid_path = None;

    let walk_result = tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        if invalid_path.is_some() {
            return TreeWalkResult::Abort;
        }
        if entry.kind() != Some(git2::ObjectType::Blob) {
            return TreeWalkResult::Ok;
        }
        let Ok(name) = entry.name() else {
            return TreeWalkResult::Ok;
        };
        let raw_path = format!("{root}{name}");
        let Ok(clean_path) = sanitize_project_path(&raw_path) else {
            invalid_path = Some(raw_path);
            return TreeWalkResult::Abort;
        };

        let parts: Vec<&str> = clean_path.split('/').collect();
        let mut acc = String::new();
        for part in parts.iter().take(parts.len().saturating_sub(1)) {
            if acc.is_empty() {
                acc.push_str(part);
            } else {
                acc.push('/');
                acc.push_str(part);
            }
            manifest.directories.insert(acc.clone());
        }

        // Keep manifest loading metadata-only; avoid blob reads for large projects.
        let size_bytes = 0_i64;
        let kind = if is_document_text_path(&clean_path) {
            CommitPathKind::Document
        } else {
            CommitPathKind::Asset
        };
        manifest.files.insert(
            clean_path.clone(),
            CommitPathMeta {
                kind,
                content_type: guess_content_type(&clean_path),
                size_bytes,
            },
        );
        TreeWalkResult::Ok
    });

    if let Some(path) = invalid_path {
        return Err(RevisionTransferError::InvalidPath { path });
    }
    walk_result.map_err(|source| RevisionTransferError::Git { source })?;
    Ok(manifest)
}

fn diff_changed_paths_between(
    repo: &Repository,
    base: &Commit<'_>,
    target: &Commit<'_>,
) -> Result<HashSet<String>, RevisionTransferError> {
    let base_tree = base
        .tree()
        .map_err(|source| RevisionTransferError::Git { source })?;
    let target_tree = target
        .tree()
        .map_err(|source| RevisionTransferError::Git { source })?;
    let mut diff_opts = git2::DiffOptions::new();
    diff_opts
        .include_typechange(true)
        .include_typechange_trees(true);
    let diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&target_tree), Some(&mut diff_opts))
        .map_err(|source| RevisionTransferError::Git { source })?;
    let mut out: HashSet<String> = HashSet::new();
    for delta in diff.deltas() {
        if let Some(old_path) = delta.old_file().path() {
            if let Some(path) = old_path.to_str() {
                if let Ok(clean) = sanitize_project_path(path) {
                    out.insert(clean);
                }
            }
        }
        if let Some(new_path) = delta.new_file().path() {
            if let Some(path) = new_path.to_str() {
                if let Ok(clean) = sanitize_project_path(path) {
                    out.insert(clean);
                }
            }
        }
    }
    Ok(out)
}

fn build_transfer_candidate(
    target_manifest: &CommitManifest,
    changed_paths: Option<&HashSet<String>>,
    anchor_kind: RevisionAnchorKind,
) -> RevisionTransferCandidate {
    let mut document_paths: Vec<String> = Vec::new();
    let mut deleted_documents: Vec<String> = Vec::new();
    let mut asset_paths: Vec<String> = Vec::new();
    let mut deleted_assets: Vec<String> = Vec::new();
    let mut estimated_bytes = 0usize;

    if let Some(paths) = changed_paths {
        let mut ordered_paths = paths.iter().cloned().collect::<Vec<_>>();
        ordered_paths.sort();
        ordered_paths.dedup();
        for path in ordered_paths {
            if let Some(meta) = target_manifest.files.get(&path) {
                match meta.kind {
                    CommitPathKind::Document => {
                        let approx_doc_bytes = usize::try_from(meta.size_bytes.max(0))
                            .unwrap_or(0)
                            .max(1024);
                        estimated_bytes = estimated_bytes
                            .saturating_add(path.len())
                            .saturating_add(approx_doc_bytes)
                            .saturating_add(24);
                        document_paths.push(path);
                    }
                    CommitPathKind::Asset => {
                        let approx_asset_bytes =
                            estimate_asset_b64_bytes(meta.size_bytes).max(256 * 1024);
                        estimated_bytes = estimated_bytes
                            .saturating_add(path.len())
                            .saturating_add(meta.content_type.len())
                            .saturating_add(approx_asset_bytes)
                            .saturating_add(32);
                        asset_paths.push(path);
                    }
                }
            } else if is_document_text_path(&path) {
                estimated_bytes = estimated_bytes
                    .saturating_add(path.len())
                    .saturating_add(12);
                deleted_documents.push(path);
            } else {
                estimated_bytes = estimated_bytes
                    .saturating_add(path.len())
                    .saturating_add(12);
                deleted_assets.push(path);
            }
        }
    } else {
        let mut paths = target_manifest.files.keys().cloned().collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            let Some(meta) = target_manifest.files.get(&path) else {
                continue;
            };
            match meta.kind {
                CommitPathKind::Document => {
                    let approx_doc_bytes = usize::try_from(meta.size_bytes.max(0))
                        .unwrap_or(0)
                        .max(1024);
                    estimated_bytes = estimated_bytes
                        .saturating_add(path.len())
                        .saturating_add(approx_doc_bytes)
                        .saturating_add(24);
                    document_paths.push(path);
                }
                CommitPathKind::Asset => {
                    let approx_asset_bytes =
                        estimate_asset_b64_bytes(meta.size_bytes).max(256 * 1024);
                    estimated_bytes = estimated_bytes
                        .saturating_add(path.len())
                        .saturating_add(meta.content_type.len())
                        .saturating_add(approx_asset_bytes)
                        .saturating_add(32);
                    asset_paths.push(path);
                }
            }
        }
    }

    RevisionTransferCandidate {
        transfer_mode: if changed_paths.is_some() {
            RevisionTransferMode::Delta
        } else {
            RevisionTransferMode::Full
        },
        anchor_kind,
        document_paths,
        deleted_documents,
        asset_paths,
        deleted_assets,
        estimated_bytes,
    }
}

fn build_nodes_from_manifest(
    target_manifest: &CommitManifest,
) -> Result<Vec<RevisionFileNode>, RevisionTransferError> {
    let mut dirs: HashSet<String> = HashSet::new();
    let mut nodes: Vec<RevisionFileNode> = Vec::new();

    for path in target_manifest.files.keys() {
        let clean = sanitize_project_path(path)
            .map_err(|_| RevisionTransferError::InvalidPath { path: path.clone() })?;
        let mut acc = String::new();
        let parts: Vec<&str> = clean.split('/').collect();
        for part in parts.iter().take(parts.len().saturating_sub(1)) {
            if acc.is_empty() {
                acc.push_str(part);
            } else {
                acc.push('/');
                acc.push_str(part);
            }
            dirs.insert(acc.clone());
        }
        nodes.push(RevisionFileNode {
            path: clean,
            kind: ProjectFileKind::File,
        });
    }

    for dir in target_manifest.directories.iter() {
        let clean = sanitize_project_path(dir)
            .map_err(|_| RevisionTransferError::InvalidPath { path: dir.clone() })?;
        dirs.insert(clean);
    }

    for dir in dirs {
        nodes.push(RevisionFileNode {
            path: dir,
            kind: ProjectFileKind::Directory,
        });
    }
    nodes.sort_by(|a, b| a.path.cmp(&b.path));
    nodes.dedup_by(|a, b| a.path == b.path && a.kind == b.kind);
    Ok(nodes)
}

fn load_blob_bytes_at_path(
    repo: &Repository,
    commit: &Commit<'_>,
    path: &str,
) -> Result<Vec<u8>, RevisionTransferError> {
    let tree = commit
        .tree()
        .map_err(|source| RevisionTransferError::Git { source })?;
    let entry = tree
        .get_path(std::path::Path::new(path))
        .map_err(|source| RevisionTransferError::Git { source })?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|source| RevisionTransferError::Git { source })?;
    Ok(blob.content().to_vec())
}

pub(crate) fn prepare_revision_transfer(
    repository_path: &str,
    default_branch: &str,
    revision_id: &str,
    current_revision_id: Option<&str>,
) -> Result<PreparedRevisionTransfer, RevisionTransferError> {
    let repository = Repository::open(repository_path)
        .map_err(|source| RevisionTransferError::Git { source })?;
    let revision_oid = Oid::from_str(revision_id)
        .map_err(|source| RevisionTransferError::InvalidRevisionId { source })?;
    let target_commit = repository.find_commit(revision_oid).map_err(|source| {
        RevisionTransferError::RevisionNotFound {
            revision_id: revision_id.to_string(),
            source,
        }
    })?;
    let target_manifest = load_commit_manifest(&target_commit)?;
    let nodes = build_nodes_from_manifest(&target_manifest)?;
    let mut candidates = vec![build_transfer_candidate(
        &target_manifest,
        None,
        RevisionAnchorKind::None,
    )];
    let mut live_base_context = None;

    if let Ok(head_ref) = repository.find_reference(&format!("refs/heads/{default_branch}")) {
        if let Ok(head_commit) = head_ref.peel_to_commit() {
            let head_id = head_commit.id().to_string();
            let head_manifest = load_commit_manifest(&head_commit)?;
            let head_to_target = if head_id != revision_id {
                let changed_paths =
                    diff_changed_paths_between(&repository, &head_commit, &target_commit)?;
                if current_revision_id.is_some() {
                    candidates.push(build_transfer_candidate(
                        &target_manifest,
                        Some(&changed_paths),
                        RevisionAnchorKind::Revision(head_id),
                    ));
                }
                changed_paths
            } else {
                HashSet::new()
            };
            live_base_context = Some((head_manifest, head_to_target));
        }
    }

    if let Some(base_revision_id) = current_revision_id {
        if base_revision_id != revision_id {
            if let Ok(base_oid) = Oid::from_str(base_revision_id) {
                if let Ok(base_commit) = repository.find_commit(base_oid) {
                    let duplicate = candidates.iter().any(|candidate| {
                        matches!(
                            &candidate.anchor_kind,
                            RevisionAnchorKind::Revision(existing) if existing == base_revision_id
                        )
                    });
                    if !duplicate {
                        let changed_paths =
                            diff_changed_paths_between(&repository, &base_commit, &target_commit)?;
                        candidates.push(build_transfer_candidate(
                            &target_manifest,
                            Some(&changed_paths),
                            RevisionAnchorKind::Revision(base_revision_id.to_string()),
                        ));
                    }
                }
            }
        }
    }

    Ok(PreparedRevisionTransfer {
        target_manifest,
        nodes,
        candidates,
        live_base_context,
    })
}

pub(crate) fn add_live_anchor_candidate(
    prepared: &mut PreparedRevisionTransfer,
    has_live_snapshot: bool,
    changed_document_paths: &[String],
    changed_asset_paths: &[String],
    live_document_paths: &[String],
    live_asset_paths: &[String],
) {
    let Some((head_manifest, head_to_target)) = prepared.live_base_context.as_ref() else {
        return;
    };
    let mut live_to_head = HashSet::new();
    if has_live_snapshot {
        live_to_head.extend(
            changed_document_paths
                .iter()
                .chain(changed_asset_paths)
                .filter_map(|path| sanitize_project_path(path).ok()),
        );
        let live_path_set = live_document_paths
            .iter()
            .chain(live_asset_paths)
            .filter_map(|path| sanitize_project_path(path).ok())
            .collect::<HashSet<_>>();
        for head_path in head_manifest.files.keys() {
            if !live_path_set.contains(head_path) {
                live_to_head.insert(head_path.clone());
            }
        }
        for live_path in live_path_set {
            if !head_manifest.files.contains_key(&live_path) {
                live_to_head.insert(live_path);
            }
        }
    }
    let mut live_union = head_to_target.clone();
    live_union.extend(live_to_head);
    prepared.candidates.push(build_transfer_candidate(
        &prepared.target_manifest,
        Some(&live_union),
        RevisionAnchorKind::Live,
    ));
}

fn select_transfer_candidate(
    target_manifest: &CommitManifest,
    candidates: Vec<RevisionTransferCandidate>,
) -> RevisionTransferCandidate {
    candidates
        .into_iter()
        .min_by_key(|candidate| {
            (
                candidate.estimated_bytes,
                usize::from(candidate.transfer_mode == RevisionTransferMode::Full),
            )
        })
        .unwrap_or_else(|| {
            build_transfer_candidate(target_manifest, None, RevisionAnchorKind::None)
        })
}

fn clean_transfer_paths(paths: Vec<String>) -> Result<Vec<String>, RevisionTransferError> {
    let mut clean_paths = paths
        .into_iter()
        .map(|path| {
            sanitize_project_path(&path).map_err(|_| RevisionTransferError::InvalidPath { path })
        })
        .collect::<Result<Vec<_>, RevisionTransferError>>()?;
    clean_paths.sort();
    clean_paths.dedup();
    Ok(clean_paths)
}

fn materialize_revision_transfer(
    repository_path: &str,
    revision_id: String,
    entry_file_path: String,
    prepared: PreparedRevisionTransfer,
    selected: RevisionTransferCandidate,
) -> Result<RevisionTransfer, RevisionTransferError> {
    let RevisionTransferCandidate {
        transfer_mode,
        anchor_kind,
        document_paths,
        deleted_documents,
        asset_paths,
        deleted_assets,
        ..
    } = selected;
    let repository = Repository::open(repository_path)
        .map_err(|source| RevisionTransferError::Git { source })?;
    let revision_oid = Oid::from_str(&revision_id)
        .map_err(|source| RevisionTransferError::InvalidRevisionId { source })?;
    let target_commit = repository.find_commit(revision_oid).map_err(|source| {
        RevisionTransferError::RevisionNotFound {
            revision_id: revision_id.clone(),
            source,
        }
    })?;

    let clean_document_paths = clean_transfer_paths(document_paths)?;
    let mut documents = Vec::with_capacity(clean_document_paths.len());
    for path in clean_document_paths {
        let bytes = load_blob_bytes_at_path(&repository, &target_commit, &path)?;
        let content = String::from_utf8(bytes).map_err(|source| {
            RevisionTransferError::InvalidDocumentEncoding {
                path: path.clone(),
                source,
            }
        })?;
        documents.push(RevisionDocument { path, content });
    }

    let clean_asset_paths = clean_transfer_paths(asset_paths)?;
    let mut assets = Vec::with_capacity(clean_asset_paths.len());
    for path in clean_asset_paths {
        let Some(meta) = prepared.target_manifest.files.get(&path) else {
            continue;
        };
        let bytes = load_blob_bytes_at_path(&repository, &target_commit, &path)?;
        assets.push(RevisionAsset {
            path,
            content_type: meta.content_type.clone(),
            size_bytes: i64::try_from(bytes.len()).unwrap_or(i64::MAX),
            content_base64: base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                bytes,
            ),
        });
    }

    let (base_anchor, base_revision_id) = match anchor_kind {
        RevisionAnchorKind::None => (RevisionBaseAnchor::None, None),
        RevisionAnchorKind::Live => (RevisionBaseAnchor::Live, None),
        RevisionAnchorKind::Revision(id) => (RevisionBaseAnchor::Revision, Some(id)),
    };
    Ok(RevisionTransfer {
        revision_id,
        entry_file_path,
        transfer_mode,
        base_anchor,
        base_revision_id,
        nodes: prepared.nodes,
        documents,
        deleted_documents: clean_transfer_paths(deleted_documents)?,
        assets,
        deleted_assets: clean_transfer_paths(deleted_assets)?,
    })
}

pub(crate) fn materialize_best_revision_transfer(
    repository_path: &str,
    revision_id: String,
    entry_file_path: String,
    mut prepared: PreparedRevisionTransfer,
) -> Result<RevisionTransfer, RevisionTransferError> {
    let selected = select_transfer_candidate(
        &prepared.target_manifest,
        std::mem::take(&mut prepared.candidates),
    );
    materialize_revision_transfer(
        repository_path,
        revision_id,
        entry_file_path,
        prepared,
        selected,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document_manifest(path: &str) -> CommitManifest {
        CommitManifest {
            files: HashMap::from([(
                path.to_string(),
                CommitPathMeta {
                    kind: CommitPathKind::Document,
                    content_type: "application/octet-stream".to_string(),
                    size_bytes: 0,
                },
            )]),
            directories: HashSet::new(),
        }
    }

    fn prepared_with_live_base(path: &str) -> PreparedRevisionTransfer {
        let target_manifest = document_manifest(path);
        PreparedRevisionTransfer {
            candidates: vec![build_transfer_candidate(
                &target_manifest,
                None,
                RevisionAnchorKind::None,
            )],
            target_manifest,
            nodes: Vec::new(),
            live_base_context: Some((document_manifest(path), HashSet::new())),
        }
    }

    #[test]
    fn missing_live_snapshot_does_not_treat_head_as_deleted() {
        let mut without_snapshot = prepared_with_live_base("main.typ");
        add_live_anchor_candidate(&mut without_snapshot, false, &[], &[], &[], &[]);
        let document_paths = without_snapshot
            .candidates
            .last()
            .map(|candidate| candidate.document_paths.as_slice());
        assert_eq!(document_paths, Some([].as_slice()));

        let mut empty_snapshot = prepared_with_live_base("main.typ");
        add_live_anchor_candidate(&mut empty_snapshot, true, &[], &[], &[], &[]);
        let document_paths = empty_snapshot
            .candidates
            .last()
            .map(|candidate| candidate.document_paths.as_slice());
        assert_eq!(document_paths, Some(["main.typ".to_string()].as_slice()));
    }
}
