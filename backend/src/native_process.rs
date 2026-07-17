//! Shared lifecycle controls for native subprocess trees.

use tokio::process::{Child, Command};

pub(crate) fn isolate_process_group(command: &mut Command) {
    command.process_group(0);
}

pub(crate) async fn terminate_process_group(child: &mut Child) {
    if let Some(process_id) = child.id() {
        if let Ok(process_group) = i32::try_from(process_id) {
            // SAFETY: the live child was created as the leader of its own
            // process group, and its PID cannot be reused until this handle is
            // reaped.
            unsafe {
                libc::kill(-process_group, libc::SIGKILL);
            }
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}
