//! Narrow process composition for Document Processing.

use super::ProcessingConfig;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct DocumentProcessingContext {
    pub(super) db: PgPool,
    pub(super) config: Arc<ProcessingConfig>,
}

impl DocumentProcessingContext {
    pub(crate) fn new(db: PgPool, config: ProcessingConfig) -> Self {
        Self {
            db,
            config: Arc::new(config),
        }
    }
}
