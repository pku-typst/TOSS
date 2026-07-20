//! Narrow process composition for Document Processing.

use super::ProcessingConfig;
use crate::object_storage::ObjectStorage;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct DocumentProcessingContext {
    pub(super) db: PgPool,
    pub(super) storage: Option<ObjectStorage>,
    pub(super) config: Arc<ProcessingConfig>,
}

impl DocumentProcessingContext {
    pub(crate) fn new(
        db: PgPool,
        storage: Option<ObjectStorage>,
        config: ProcessingConfig,
    ) -> Self {
        Self {
            db,
            storage,
            config: Arc::new(config),
        }
    }

    pub(crate) fn configured_operations(&self) -> Vec<super::ProcessingOperation> {
        self.config.configured_operations()
    }
}
