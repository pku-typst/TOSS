use super::super::revision_state::GitRevisionState;
use crate::app_state::AppState;
use crate::workspace::{
    load_project_content_asset_bytes, LoadProjectContentAssetError, ProjectContentSnapshot,
};
use git2::{IndexEntry, IndexTime, MergeFileOptions, Repository};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

#[derive(Clone)]
pub(super) enum MergeFileValue {
    Text(String),
    Binary {
        bytes: Vec<u8>,
        content_type: String,
    },
}

fn merge_file_equal(left: &MergeFileValue, right: &MergeFileValue) -> bool {
    match (left, right) {
        (MergeFileValue::Text(left), MergeFileValue::Text(right)) => left == right,
        (
            MergeFileValue::Binary {
                bytes: left_bytes,
                content_type: left_content_type,
            },
            MergeFileValue::Binary {
                bytes: right_bytes,
                content_type: right_content_type,
            },
        ) => left_bytes == right_bytes && left_content_type == right_content_type,
        _ => false,
    }
}

pub(super) fn push_reject_hint_lines(reason: &str) -> Vec<String> {
    if reason == "forced push prohibited" {
        return vec![
            "error: forced push prohibited\n".to_string(),
            "\n".to_string(),
            "hint: You can't git push --force to this Typst project. Rebase or merge on top of current head.\n".to_string(),
        ];
    }
    if reason.starts_with("fetch first:") {
        return vec![
            "error: push rejected because server has newer online updates\n".to_string(),
            "hint: Pull latest changes, rebase/merge your local commit, then push again.\n"
                .to_string(),
        ];
    }
    vec![format!("error: {reason}\n")]
}

fn pkt_line(payload: &str) -> Vec<u8> {
    let total_len = payload.len() + 4;
    format!("{total_len:04x}{payload}").into_bytes()
}

fn pkt_line_bytes(payload: &[u8]) -> Vec<u8> {
    let total_len = payload.len() + 4;
    let mut output = format!("{total_len:04x}").into_bytes();
    output.extend_from_slice(payload);
    output
}

pub(super) fn git_receive_pack_reject_body(
    ref_name: &str,
    reason: &str,
    hints: &[String],
) -> Vec<u8> {
    let mut report = Vec::new();
    report.extend(pkt_line("unpack ok\n"));
    report.extend(pkt_line(&format!("ng {ref_name} {reason}\n")));
    report.extend_from_slice(b"0000");

    let mut output = Vec::new();
    for line in hints {
        let mut payload = Vec::with_capacity(1 + line.len());
        payload.push(2_u8);
        payload.extend(line.as_bytes());
        output.extend(pkt_line_bytes(&payload));
    }
    let mut report_band = Vec::with_capacity(report.len() + 1);
    report_band.push(1_u8);
    report_band.extend(report);
    output.extend(pkt_line_bytes(&report_band));
    output.extend_from_slice(b"0000");
    output
}

fn merge_index_entry_from_text(
    repository: &Repository,
    path: &str,
    content: &str,
) -> Result<IndexEntry, git2::Error> {
    let id = repository.blob(content.as_bytes())?;
    Ok(IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: 0o100644,
        uid: 0,
        gid: 0,
        file_size: u32::try_from(content.len()).unwrap_or(u32::MAX),
        id,
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    })
}

#[derive(Debug, Error)]
enum MergeTextError {
    #[error("Git text merge failed")]
    Git {
        #[from]
        source: git2::Error,
    },
    #[error("merged text is not valid UTF-8")]
    InvalidEncoding {
        #[from]
        source: std::str::Utf8Error,
    },
}

fn three_way_merge_text(
    repository: &Repository,
    path: &str,
    base: &str,
    pushed: &str,
    online: &str,
) -> Result<Option<String>, MergeTextError> {
    let ancestor = merge_index_entry_from_text(repository, path, base)?;
    let ours = merge_index_entry_from_text(repository, path, pushed)?;
    let theirs = merge_index_entry_from_text(repository, path, online)?;
    let mut options = MergeFileOptions::new();
    options
        .ancestor_label("base")
        .our_label("pushed")
        .their_label("online");
    let merged = repository.merge_file_from_index(&ancestor, &ours, &theirs, Some(&mut options))?;
    if !merged.is_automergeable() {
        return Ok(None);
    }
    let text = std::str::from_utf8(merged.content())?.to_string();
    Ok(Some(text))
}

pub(super) async fn workspace_snapshot_to_merge_map(
    state: &AppState,
    source: &ProjectContentSnapshot,
) -> Result<HashMap<String, MergeFileValue>, LoadProjectContentAssetError> {
    let mut output = HashMap::new();
    for (path, content) in &source.documents {
        output.insert(path.clone(), MergeFileValue::Text(content.clone()));
    }
    for (path, asset) in &source.assets {
        let bytes = load_project_content_asset_bytes(state.storage.as_ref(), asset).await?;
        output.insert(
            path.clone(),
            MergeFileValue::Binary {
                bytes,
                content_type: asset.content_type.clone(),
            },
        );
    }
    Ok(output)
}

pub(super) fn git_revision_state_to_merge_map(
    source: GitRevisionState,
) -> HashMap<String, MergeFileValue> {
    let mut output = source
        .documents
        .into_iter()
        .map(|(path, content)| (path, MergeFileValue::Text(content)))
        .collect::<HashMap<_, _>>();
    output.extend(source.assets.into_iter().map(|(path, asset)| {
        (
            path,
            MergeFileValue::Binary {
                bytes: asset.bytes,
                content_type: asset.content_type,
            },
        )
    }));
    output
}

pub(super) fn merge_online_over_pushed(
    repository: &Repository,
    base: &HashMap<String, MergeFileValue>,
    pushed: &HashMap<String, MergeFileValue>,
    online: &HashMap<String, MergeFileValue>,
) -> MergeWorkspaceResult {
    let mut keys = HashSet::new();
    keys.extend(base.keys().cloned());
    keys.extend(pushed.keys().cloned());
    keys.extend(online.keys().cloned());

    let mut merged = HashMap::new();
    let mut conflicts = Vec::new();
    for key in keys {
        let base_value = base.get(&key);
        let pushed_value = pushed.get(&key);
        let online_value = online.get(&key);
        let online_changed = match (base_value, online_value) {
            (Some(left), Some(right)) => !merge_file_equal(left, right),
            (None, None) => false,
            _ => true,
        };
        let pushed_changed = match (base_value, pushed_value) {
            (Some(left), Some(right)) => !merge_file_equal(left, right),
            (None, None) => false,
            _ => true,
        };
        let merged_value = if !online_changed {
            pushed_value.cloned()
        } else if !pushed_changed {
            online_value.cloned()
        } else {
            match (base_value, pushed_value, online_value) {
                (
                    Some(MergeFileValue::Text(base_text)),
                    Some(MergeFileValue::Text(pushed_text)),
                    Some(MergeFileValue::Text(online_text)),
                ) => match three_way_merge_text(
                    repository,
                    &key,
                    base_text,
                    pushed_text,
                    online_text,
                ) {
                    Ok(Some(merged_text)) => Some(MergeFileValue::Text(merged_text)),
                    Ok(None) | Err(_) => {
                        conflicts.push(key.clone());
                        None
                    }
                },
                (_, Some(left), Some(right)) if merge_file_equal(left, right) => Some(left.clone()),
                (_, None, None) => None,
                _ => {
                    conflicts.push(key.clone());
                    None
                }
            }
        };
        if let Some(value) = merged_value {
            merged.insert(key, value);
        }
    }
    if conflicts.is_empty() {
        MergeWorkspaceResult::Merged(merged)
    } else {
        conflicts.sort();
        MergeWorkspaceResult::Conflicts(conflicts)
    }
}

pub(super) enum MergeWorkspaceResult {
    Merged(HashMap<String, MergeFileValue>),
    Conflicts(Vec<String>),
}

pub(super) fn materialize_merge_map_to_dir(
    root: &std::path::Path,
    merged: &HashMap<String, MergeFileValue>,
) -> Result<(), std::io::Error> {
    for (path, value) in merged {
        let target = root.join(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match value {
            MergeFileValue::Text(content) => {
                std::fs::write(&target, content.as_bytes())?;
            }
            MergeFileValue::Binary { bytes, .. } => {
                std::fs::write(&target, bytes)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        git_receive_pack_reject_body, git_revision_state_to_merge_map, push_reject_hint_lines,
        MergeFileValue,
    };
    use crate::versioning::revision_state::{GitRevisionAsset, GitRevisionState};
    use std::collections::HashMap;

    #[test]
    fn receive_pack_rejection_contains_reason_and_hints() {
        let reason = "forced push prohibited";
        let hints = push_reject_hint_lines(reason);
        let body = git_receive_pack_reject_body("refs/heads/main", reason, &hints);

        assert!(body
            .windows(reason.len())
            .any(|window| window == reason.as_bytes()));
        assert!(body
            .windows("git push --force".len())
            .any(|window| window == b"git push --force"));
    }

    #[test]
    fn git_revision_state_conversion_preserves_text_and_binary_content() {
        let state = GitRevisionState {
            documents: HashMap::from([("main.typ".to_string(), "= title".to_string())]),
            assets: HashMap::from([(
                "image.bin".to_string(),
                GitRevisionAsset {
                    content_type: "application/octet-stream".to_string(),
                    bytes: vec![0, 1, 2],
                },
            )]),
        };

        let files = git_revision_state_to_merge_map(state);
        assert!(matches!(
            files.get("main.typ"),
            Some(MergeFileValue::Text(content)) if content == "= title"
        ));
        assert!(matches!(
            files.get("image.bin"),
            Some(MergeFileValue::Binary {
                bytes,
                content_type,
            }) if bytes == &[0, 1, 2] && content_type == "application/octet-stream"
        ));
    }
}
