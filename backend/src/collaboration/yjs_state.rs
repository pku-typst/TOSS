//! Validation and deterministic compaction for Yjs-compatible updates.

use thiserror::Error;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

pub(super) struct MergedYjsState {
    pub update: Vec<u8>,
    pub text: String,
}

pub(super) fn seed_text(content: &str) -> Vec<u8> {
    let document = Doc::with_client_id(1);
    if !content.is_empty() {
        document
            .get_or_insert_text("main")
            .insert(&mut document.transact_mut(), 0, content);
    }
    let update = document
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    update
}

pub(super) fn validate_update(payload: &[u8]) -> Result<(), YjsStateError> {
    let document = Doc::new();
    document
        .transact_mut()
        .apply_update(Update::decode_v1(payload)?)?;
    Ok(())
}

pub(super) fn merge_updates<'update>(
    snapshot: Option<&'update [u8]>,
    updates: impl IntoIterator<Item = &'update [u8]>,
) -> Result<MergedYjsState, YjsStateError> {
    let document = Doc::new();
    {
        let mut transaction = document.transact_mut();
        if let Some(snapshot) = snapshot {
            transaction.apply_update(Update::decode_v1(snapshot)?)?;
        }
        for payload in updates {
            transaction.apply_update(Update::decode_v1(payload)?)?;
        }
    }
    let text = document
        .get_or_insert_text("main")
        .get_string(&document.transact());
    let update = document
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    Ok(MergedYjsState { update, text })
}

#[derive(Debug, Error)]
pub(crate) enum YjsStateError {
    #[error("could not decode a Yjs update")]
    Decode(#[from] yrs::encoding::read::Error),
    #[error("could not apply a Yjs update")]
    Apply(#[from] yrs::error::UpdateError),
}

#[cfg(test)]
mod tests {
    use super::{merge_updates, seed_text};
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

    #[test]
    fn compaction_merges_concurrent_updates() -> Result<(), Box<dyn std::error::Error>> {
        let first = Doc::with_client_id(1);
        first
            .get_or_insert_text("main")
            .insert(&mut first.transact_mut(), 0, "A");
        let first_update = first
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let second = Doc::with_client_id(2);
        second
            .get_or_insert_text("main")
            .insert(&mut second.transact_mut(), 0, "B");
        let second_update = second
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let compacted = merge_updates(Some(first_update.as_slice()), [second_update.as_slice()])?;
        let restored = Doc::new();
        restored
            .transact_mut()
            .apply_update(Update::decode_v1(&compacted.update)?)?;
        let text = restored
            .get_or_insert_text("main")
            .get_string(&restored.transact());
        assert_eq!(text.len(), 2);
        assert!(text.contains('A'));
        assert!(text.contains('B'));
        assert_eq!(compacted.text, text);
        Ok(())
    }

    #[test]
    fn canonical_text_seed_round_trips() -> Result<(), Box<dyn std::error::Error>> {
        let restored = Doc::new();
        restored
            .transact_mut()
            .apply_update(Update::decode_v1(&seed_text("canonical"))?)?;
        assert_eq!(
            restored
                .get_or_insert_text("main")
                .get_string(&restored.transact()),
            "canonical"
        );
        Ok(())
    }
}
