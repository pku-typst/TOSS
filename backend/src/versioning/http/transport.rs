//! Bounded-memory execution and response streaming for `git http-backend`.

use crate::native_process::{isolate_process_group, terminate_process_group};
use crate::process_lifecycle::DrainSignal;
use axum::body::{Body, Bytes};
use futures::stream;
use std::fmt;
use std::io::{ErrorKind, SeekFrom};
use std::process::ExitStatus;
use std::time::Duration;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, Command};

const RESPONSE_CHUNK_BYTES: usize = 64 * 1024;
const STDERR_DIAGNOSTIC_BYTES: usize = 512;

#[derive(Debug)]
pub(super) enum GitBackendExecutionError {
    Io(std::io::Error),
    Interrupted,
    TimedOut,
}

impl fmt::Display for GitBackendExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Interrupted => formatter.write_str("execution interrupted by process drain"),
            Self::TimedOut => formatter.write_str("execution timed out"),
        }
    }
}

impl std::error::Error for GitBackendExecutionError {}

impl From<std::io::Error> for GitBackendExecutionError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

pub(super) struct GitBackendOutput {
    pub status: ExitStatus,
    pub stderr: String,
    stdout: File,
    stdout_len: u64,
}

impl GitBackendOutput {
    pub fn stdout_is_empty(&self) -> bool {
        self.stdout_len == 0
    }

    pub async fn read_stdout_prefix(&mut self, limit: usize) -> Result<Vec<u8>, std::io::Error> {
        self.stdout.seek(SeekFrom::Start(0)).await?;
        let read_len_u64 = self.stdout_len.min(limit as u64);
        let read_len = usize::try_from(read_len_u64).map_err(|conversion_error| {
            std::io::Error::new(
                ErrorKind::InvalidData,
                format!("Git response prefix length is invalid: {conversion_error}"),
            )
        })?;
        let mut prefix = vec![0; read_len];
        self.stdout.read_exact(&mut prefix).await?;
        Ok(prefix)
    }

    pub fn stdout_len(&self) -> u64 {
        self.stdout_len
    }

    pub async fn into_body(mut self, offset: u64) -> Result<Body, std::io::Error> {
        if offset > self.stdout_len {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "Git response body offset exceeds its output length",
            ));
        }
        self.stdout.seek(SeekFrom::Start(offset)).await?;
        let stream = stream::try_unfold(self.stdout, |mut file| async move {
            let mut chunk = vec![0; RESPONSE_CHUNK_BYTES];
            let bytes_read = file.read(&mut chunk).await?;
            if bytes_read == 0 {
                return Ok::<Option<(Bytes, File)>, std::io::Error>(None);
            }
            chunk.truncate(bytes_read);
            Ok(Some((Bytes::from(chunk), file)))
        });
        Ok(Body::from_stream(stream))
    }
}

pub(super) async fn execute_git_http_backend(
    mut command: Command,
    request_body: Bytes,
    timeout: Duration,
    drain: DrainSignal,
) -> Result<GitBackendOutput, GitBackendExecutionError> {
    let stdout_file = tempfile::tempfile()?;
    isolate_process_group(&mut command);
    let mut child = command.spawn()?;
    enum Execution<T> {
        Complete(T),
        Interrupted,
    }
    let execution = {
        let child_execution = execute_child(&mut child, request_body, File::from_std(stdout_file));
        tokio::pin!(child_execution);
        tokio::select! {
            biased;
            _ = drain.triggered() => Execution::Interrupted,
            result = tokio::time::timeout(timeout, &mut child_execution) => Execution::Complete(result),
        }
    };
    match execution {
        Execution::Complete(Ok(Ok(output))) => Ok(output),
        Execution::Complete(Ok(Err(error))) => {
            terminate_process_group(&mut child).await;
            Err(GitBackendExecutionError::Io(error))
        }
        Execution::Complete(Err(_)) => {
            terminate_process_group(&mut child).await;
            Err(GitBackendExecutionError::TimedOut)
        }
        Execution::Interrupted => {
            terminate_process_group(&mut child).await;
            Err(GitBackendExecutionError::Interrupted)
        }
    }
}

async fn execute_child(
    child: &mut Child,
    request_body: Bytes,
    stdout_file: File,
) -> Result<GitBackendOutput, std::io::Error> {
    let mut stdin = child.stdin.take().ok_or_else(|| missing_pipe("stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| missing_pipe("stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| missing_pipe("stderr"))?;

    let write_stdin = async move {
        stdin.write_all(&request_body).await?;
        stdin.shutdown().await
    };
    let capture_stdout = async move {
        let mut stdout = BufReader::new(stdout);
        let mut output = stdout_file;
        let bytes_written = tokio::io::copy(&mut stdout, &mut output).await?;
        output.flush().await?;
        Ok::<_, std::io::Error>((output, bytes_written))
    };
    let capture_stderr = retain_stderr_prefix(stderr);
    let ((), (stdout, stdout_len), stderr) =
        tokio::try_join!(write_stdin, capture_stdout, capture_stderr)?;
    let status = child.wait().await?;

    Ok(GitBackendOutput {
        status,
        stderr,
        stdout,
        stdout_len,
    })
}

async fn retain_stderr_prefix(stderr: ChildStderr) -> Result<String, std::io::Error> {
    let mut stderr = BufReader::new(stderr);
    let mut retained = Vec::with_capacity(STDERR_DIAGNOSTIC_BYTES);
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let bytes_read = stderr.read(&mut chunk).await?;
        if bytes_read == 0 {
            break;
        }
        let remaining = STDERR_DIAGNOSTIC_BYTES.saturating_sub(retained.len());
        let retain_count = remaining.min(bytes_read);
        if let Some(bytes) = chunk.get(..retain_count) {
            retained.extend_from_slice(bytes);
        }
    }
    Ok(String::from_utf8_lossy(&retained).into_owned())
}

fn missing_pipe(name: &str) -> std::io::Error {
    std::io::Error::new(
        ErrorKind::BrokenPipe,
        format!("Git backend {name} was not piped"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[tokio::test]
    async fn file_response_body_starts_at_offset_and_streams_in_chunks(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let std_file = tempfile::tempfile()?;
        let mut file = File::from_std(std_file);
        let payload = vec![b'x'; RESPONSE_CHUNK_BYTES * 2 + 17];
        file.write_all(b"headers\r\n\r\n").await?;
        file.write_all(&payload).await?;
        let output = GitBackendOutput {
            status: successful_exit_status(),
            stderr: String::new(),
            stdout: file,
            stdout_len: (payload.len() + 11) as u64,
        };

        let body = output.into_body(11).await?;
        let mut stream = body.into_data_stream();
        let mut chunks = 0_usize;
        let mut bytes = 0_usize;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            chunks = chunks.saturating_add(1);
            bytes = bytes.saturating_add(chunk.len());
        }

        assert_eq!(bytes, payload.len());
        assert!(chunks >= 3);
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_drain_interrupts_and_reaps_the_git_backend() {
        let drain = DrainSignal::idle();
        let trigger = drain.clone();
        let mut command = Command::new("sh");
        command.arg("-c").arg("exec sleep 10");
        command.stdin(std::process::Stdio::piped());
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        command.kill_on_drop(true);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            trigger.trigger_for_test();
        });

        let result =
            execute_git_http_backend(command, Bytes::new(), Duration::from_secs(5), drain).await;
        assert!(matches!(result, Err(GitBackendExecutionError::Interrupted)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pipe_setup_failure_terminates_the_git_backend(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut command = Command::new("sh");
        command.arg("-c").arg("exec sleep 10").kill_on_drop(true);

        let result = tokio::time::timeout(
            Duration::from_secs(1),
            execute_git_http_backend(
                command,
                Bytes::new(),
                Duration::from_secs(5),
                DrainSignal::idle(),
            ),
        )
        .await?;

        assert!(matches!(result, Err(GitBackendExecutionError::Io(_))));
        Ok(())
    }

    #[cfg(unix)]
    fn successful_exit_status() -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(0)
    }

    #[cfg(windows)]
    fn successful_exit_status() -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(0)
    }
}
