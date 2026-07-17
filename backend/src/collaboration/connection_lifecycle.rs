//! Collaboration-owned tracking for active realtime connections.

use tokio::sync::watch;

#[derive(Clone)]
pub(super) struct ConnectionTracker {
    active: watch::Sender<usize>,
}

impl Default for ConnectionTracker {
    fn default() -> Self {
        let (active, _) = watch::channel(0);
        Self { active }
    }
}

impl ConnectionTracker {
    pub(super) fn track(&self) -> ConnectionActivity {
        self.active
            .send_modify(|active| *active = active.saturating_add(1));
        ConnectionActivity {
            tracker: self.clone(),
        }
    }

    pub(super) async fn wait_for_quiescence(&self) {
        let mut active = self.active.subscribe();
        while *active.borrow() != 0 {
            if active.changed().await.is_err() {
                return;
            }
        }
    }
}

pub(super) struct ConnectionActivity {
    tracker: ConnectionTracker,
}

impl Drop for ConnectionActivity {
    fn drop(&mut self) {
        self.tracker.active.send_modify(|active| {
            *active = active.saturating_sub(1);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn quiescence_waits_for_every_connection() -> Result<(), tokio::time::error::Elapsed> {
        let tracker = ConnectionTracker::default();
        let first = tracker.track();
        let second = tracker.track();

        assert!(
            tokio::time::timeout(Duration::from_millis(10), tracker.wait_for_quiescence())
                .await
                .is_err()
        );
        drop(first);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), tracker.wait_for_quiescence())
                .await
                .is_err()
        );
        drop(second);
        tokio::time::timeout(Duration::from_millis(100), tracker.wait_for_quiescence()).await?;
        Ok(())
    }
}
