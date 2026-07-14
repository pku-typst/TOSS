use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

#[derive(Clone, Default)]
pub(crate) struct VersioningContext {
    project_locks: Arc<RwLock<HashMap<Uuid, Arc<Mutex<()>>>>>,
}

impl VersioningContext {
    async fn get_or_create_project_lock(&self, project_id: Uuid) -> Arc<Mutex<()>> {
        if let Some(lock) = self.project_locks.read().await.get(&project_id).cloned() {
            return lock;
        }
        let mut write = self.project_locks.write().await;
        if let Some(lock) = write.get(&project_id).cloned() {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        write.insert(project_id, lock.clone());
        lock
    }

    pub(crate) async fn acquire_project_lock(
        &self,
        project_id: Uuid,
    ) -> tokio::sync::OwnedMutexGuard<()> {
        self.get_or_create_project_lock(project_id)
            .await
            .lock_owned()
            .await
    }
}
