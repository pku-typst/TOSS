use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};
use tokio::sync::Mutex;

static LOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();

pub(super) async fn lock_for(key: &str) -> Arc<Mutex<()>> {
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().await;
    locks.retain(|_, value| value.strong_count() > 0);
    if let Some(existing) = locks.get(key).and_then(Weak::upgrade) {
        return existing;
    }
    let created = Arc::new(Mutex::new(()));
    locks.insert(key.to_string(), Arc::downgrade(&created));
    created
}

#[cfg(test)]
mod tests {
    use super::lock_for;
    use std::sync::Arc;

    #[tokio::test]
    async fn callers_share_a_live_key_lock() {
        let first = lock_for("latex-test-key").await;
        let second = lock_for("latex-test-key").await;
        assert!(Arc::ptr_eq(&first, &second));
    }
}
