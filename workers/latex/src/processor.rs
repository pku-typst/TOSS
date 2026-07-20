use crate::contract::{development_processor_contract, processor_contract};
use async_trait::async_trait;
use serde::Deserialize;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tempfile::TempDir;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::watch;
use toss_processing_sdk::{
    safe_relative_path, Processor, ProcessorArtifact, ProcessorDescriptor, ProcessorFailure,
    ProcessorRequest, ProcessorResult, WorkerFailureClass,
};

const OPERATION: &str = "latex.compile.pdf/v1";
const DEFAULT_MEMORY_BYTES: i64 = 2 * 1024 * 1024 * 1024;
const MAX_CAPTURE_BYTES: usize = 512 * 1024;

pub struct LatexProcessor {
    slots: i32,
    executor: Executor,
    latexmkrc: PathBuf,
    memory_bytes: i64,
    processor_contract: String,
    runtime_version: String,
}

#[derive(Clone, Copy)]
enum Executor {
    Bubblewrap,
    Process,
}

#[derive(Deserialize)]
struct LatexOptions {
    engine: String,
    entry_file_path: String,
    source_epoch: i64,
}

enum ProcessOutcome {
    Exited(std::process::ExitStatus),
    Cancelled,
    TimedOut,
}

struct CommandOutput {
    outcome: ProcessOutcome,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

struct JobPaths {
    _root: TempDir,
    root: PathBuf,
    work: PathBuf,
    build: PathBuf,
    home: PathBuf,
    texmf_var: PathBuf,
    texmf_config: PathBuf,
    texmf_cache: PathBuf,
    texmf_home: PathBuf,
    tmp: PathBuf,
}

impl LatexProcessor {
    pub fn from_env() -> Result<Self, String> {
        let slots = std::env::var("PROCESSING_LATEX_SLOTS")
            .ok()
            .map(|value| value.parse::<i32>())
            .transpose()
            .map_err(|error| format!("PROCESSING_LATEX_SLOTS: {error}"))?
            .unwrap_or(1);
        if !(1..=16).contains(&slots) {
            return Err("PROCESSING_LATEX_SLOTS must be between 1 and 16".to_string());
        }
        let (executor, processor_contract, runtime_version) =
            match std::env::var("PROCESSING_LATEX_EXECUTOR")
                .unwrap_or_else(|_| "bubblewrap".to_string())
                .as_str()
            {
                "bubblewrap" => (
                    Executor::Bubblewrap,
                    processor_contract(),
                    "texlive-2026-r79639/latexmk-4.88/bubblewrap".to_string(),
                ),
                "process" => (
                    Executor::Process,
                    development_processor_contract(),
                    "texlive-2026-r79639/latexmk-4.88/process-development".to_string(),
                ),
                value => return Err(format!("unknown PROCESSING_LATEX_EXECUTOR {value}")),
            };
        let latexmkrc = std::env::var("PROCESSING_LATEXMKRC")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/opt/toss/latex-worker/latexmkrc"));
        if !latexmkrc.is_file() {
            return Err(format!("latexmk recipe {} is missing", latexmkrc.display()));
        }
        let recipe = std::fs::read(&latexmkrc)
            .map_err(|error| format!("latexmk recipe {}: {error}", latexmkrc.display()))?;
        if recipe.as_slice() != include_bytes!("../latexmkrc") {
            return Err("PROCESSING_LATEXMKRC must contain the contract-owned recipe".to_string());
        }
        Ok(Self {
            slots,
            executor,
            latexmkrc,
            memory_bytes: DEFAULT_MEMORY_BYTES,
            processor_contract,
            runtime_version,
        })
    }
}

#[async_trait]
impl Processor for LatexProcessor {
    fn descriptor(&self) -> ProcessorDescriptor {
        ProcessorDescriptor {
            operation: OPERATION.to_string(),
            processor_contract: self.processor_contract.clone(),
            runtime_version: self.runtime_version.clone(),
            slots: self.slots,
        }
    }

    async fn process(
        &self,
        request: ProcessorRequest,
        cancellation: watch::Receiver<bool>,
    ) -> Result<ProcessorResult, ProcessorFailure> {
        let project = request.project().ok_or_else(|| {
            invalid_input(
                "project_input_required",
                "LaTeX compilation requires a project bundle",
            )
        })?;
        let options = validate_options(&request)?;
        let paths = prepare_job(&project.project_dir).map_err(io_failure)?;
        let command = build_command(self, &paths, &options, &request)?;
        let output = run_command(
            command,
            cancellation,
            Duration::from_secs(request.limits.wall_seconds.max(1) as u64),
        )
        .await
        .map_err(io_failure)?;
        let diagnostic =
            load_diagnostic(&paths, &options, &output, request.limits.diagnostic_bytes);
        match output.outcome {
            ProcessOutcome::Cancelled => {
                return Err(ProcessorFailure::new(
                    WorkerFailureClass::WorkerInterrupted,
                    "claim_cancelled",
                    "The build stopped after cancellation or lease loss",
                ));
            }
            ProcessOutcome::TimedOut => {
                return Err(ProcessorFailure::new(
                    WorkerFailureClass::ResourceLimit,
                    "latex_timeout",
                    diagnostic,
                ));
            }
            ProcessOutcome::Exited(status) if !status.success() => {
                let (class, code) = if missing_dependency(&diagnostic) {
                    (
                        WorkerFailureClass::UnsupportedDependency,
                        "package_unavailable",
                    )
                } else {
                    (
                        WorkerFailureClass::ProcessorRejected,
                        "latex_compile_failed",
                    )
                };
                return Err(ProcessorFailure::new(class, code, diagnostic));
            }
            ProcessOutcome::Exited(_) => {}
        }

        let stem = Path::new(&options.entry_file_path)
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| invalid_input("entry_file_invalid", "Entry filename is invalid"))?;
        let pdf_path = paths.build.join(format!("{stem}.pdf"));
        let pdf = read_bounded(&pdf_path, request.limits.output_bytes).map_err(|error| {
            if error.kind() == std::io::ErrorKind::FileTooLarge {
                ProcessorFailure::new(
                    WorkerFailureClass::ResourceLimit,
                    "pdf_too_large",
                    "Generated PDF exceeds the configured output limit",
                )
            } else {
                io_failure(error)
            }
        })?;
        if !pdf.starts_with(b"%PDF-") {
            return Err(ProcessorFailure::new(
                WorkerFailureClass::InternalContractViolation,
                "pdf_invalid",
                "LaTeX completed without a valid PDF output",
            ));
        }
        Ok(ProcessorResult {
            artifacts: vec![
                ProcessorArtifact {
                    role: "pdf".to_string(),
                    media_type: "application/pdf".to_string(),
                    filename: format!("{stem}.pdf"),
                    content: pdf,
                },
                ProcessorArtifact {
                    role: "log".to_string(),
                    media_type: "text/plain".to_string(),
                    filename: format!("{stem}.log"),
                    content: nonempty_diagnostic(diagnostic).into_bytes(),
                },
            ],
            metadata: serde_json::json!({
                "engine": options.engine,
                "source_epoch": options.source_epoch,
            }),
        })
    }
}

fn validate_options(request: &ProcessorRequest) -> Result<LatexOptions, ProcessorFailure> {
    let project = request.project().ok_or_else(|| {
        invalid_input(
            "project_input_required",
            "LaTeX compilation requires a project bundle",
        )
    })?;
    let options: LatexOptions = serde_json::from_value(request.options.clone())
        .map_err(|_| invalid_input("options_invalid", "LaTeX build options are invalid"))?;
    if project.manifest.schema != "project-bundle/v1"
        || project.manifest.project_type != "latex"
        || !project.manifest.packages.is_empty()
        || !matches!(options.engine.as_str(), "pdftex" | "xetex")
        || !safe_relative_path(&options.entry_file_path)
        || options.entry_file_path != project.manifest.entry_file_path
        || Some(options.engine.as_str()) != project.manifest.latex_engine.as_deref()
        || options.source_epoch != project.manifest.source_epoch
    {
        return Err(invalid_input(
            "options_manifest_mismatch",
            "LaTeX options do not match the immutable project manifest",
        ));
    }
    Ok(options)
}

fn prepare_job(project_dir: &Path) -> Result<JobPaths, std::io::Error> {
    let root = tempfile::tempdir()?;
    let root_path = root.path().to_path_buf();
    let paths = JobPaths {
        _root: root,
        root: root_path.clone(),
        work: root_path.join("work"),
        build: root_path.join("build"),
        home: root_path.join("home"),
        texmf_var: root_path.join("texmf-var"),
        texmf_config: root_path.join("texmf-config"),
        texmf_cache: root_path.join("texmf-cache"),
        texmf_home: root_path.join("texmf-home"),
        tmp: root_path.join("tmp"),
    };
    copy_tree(project_dir, &paths.work)?;
    for directory in [
        &paths.build,
        &paths.home,
        &paths.texmf_var,
        &paths.texmf_config,
        &paths.texmf_cache,
        &paths.texmf_home,
        &paths.tmp,
    ] {
        fs::create_dir(directory)?;
    }
    Ok(paths)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "project contains an unsupported file type",
            ));
        }
    }
    Ok(())
}

fn build_command(
    processor: &LatexProcessor,
    paths: &JobPaths,
    options: &LatexOptions,
    request: &ProcessorRequest,
) -> Result<Command, ProcessorFailure> {
    match processor.executor {
        Executor::Bubblewrap => build_bubblewrap_command(processor, paths, options, request),
        Executor::Process => Ok(build_process_command(processor, paths, options, request)),
    }
}

fn build_process_command(
    processor: &LatexProcessor,
    paths: &JobPaths,
    options: &LatexOptions,
    request: &ProcessorRequest,
) -> Command {
    let mut command = Command::new("prlimit");
    add_limits(&mut command, processor, request);
    command.arg("--").arg("latexmk");
    add_latexmk_arguments(&mut command, options, &processor.latexmkrc, &paths.build);
    command.current_dir(&paths.work);
    apply_environment(&mut command, paths, options.source_epoch, false);
    command
}

fn build_bubblewrap_command(
    processor: &LatexProcessor,
    paths: &JobPaths,
    options: &LatexOptions,
    request: &ProcessorRequest,
) -> Result<Command, ProcessorFailure> {
    let runtime_path = std::env::var("PATH").map_err(|_| {
        ProcessorFailure::new(
            WorkerFailureClass::InternalContractViolation,
            "runtime_path_missing",
            "The TeX runtime PATH is not configured",
        )
    })?;
    let mut command = Command::new("prlimit");
    add_limits(&mut command, processor, request);
    command
        .arg("--")
        .arg("/usr/local/bin/toss-bwrap")
        .args([
            "--die-with-parent",
            "--new-session",
            "--unshare-all",
            "--clearenv",
            "--dir",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind-try",
            "/bin",
            "/bin",
            "--ro-bind-try",
            "/lib",
            "/lib",
            "--ro-bind-try",
            "/lib64",
            "/lib64",
            "--ro-bind-try",
            "/usr/local/texlive",
            "/usr/local/texlive",
            "--ro-bind-try",
            "/etc/texmf",
            "/etc/texmf",
            "--ro-bind-try",
            "/var/lib/texmf",
            "/var/lib/texmf",
            "--ro-bind-try",
            "/etc/fonts",
            "/etc/fonts",
            "--ro-bind-try",
            "/var/cache/fontconfig",
            "/var/cache/fontconfig",
            "--dir",
            "/runtime",
            "--ro-bind",
        ])
        .arg(&processor.latexmkrc)
        .arg("/runtime/latexmkrc")
        .arg("--bind")
        .arg(&paths.root)
        .arg("/job")
        .args(["--chdir", "/job/work", "--setenv", "PATH"])
        .arg(runtime_path)
        .args(environment_arguments(options.source_epoch))
        .arg("latexmk");
    add_latexmk_arguments(
        &mut command,
        options,
        Path::new("/runtime/latexmkrc"),
        Path::new("/job/build"),
    );
    command.env_clear();
    Ok(command)
}

fn add_limits(command: &mut Command, processor: &LatexProcessor, request: &ProcessorRequest) {
    let file_limit = request
        .limits
        .output_bytes
        .saturating_add(request.limits.diagnostic_bytes)
        .max(1);
    command
        .arg(format!("--as={}", processor.memory_bytes))
        .arg(format!(
            "--cpu={}",
            request.limits.wall_seconds.saturating_add(10).max(1)
        ))
        .arg("--nproc=128")
        .arg("--nofile=256")
        .arg(format!("--fsize={file_limit}"));
}

fn add_latexmk_arguments(
    command: &mut Command,
    options: &LatexOptions,
    recipe: &Path,
    build: &Path,
) {
    command
        .args(["-norc", "-r"])
        .arg(recipe)
        .arg(if options.engine == "xetex" {
            "-xelatex"
        } else {
            "-pdf"
        })
        .args([
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
        ])
        .arg(format!("-outdir={}", build.display()))
        .arg(format!("./{}", options.entry_file_path));
}

fn apply_environment(command: &mut Command, paths: &JobPaths, source_epoch: i64, sandbox: bool) {
    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string());
    command
        .env_clear()
        .env("PATH", path)
        .env("HOME", &paths.home)
        .env("TMPDIR", &paths.tmp)
        .env("TEXMFHOME", &paths.texmf_home)
        .env("TEXMFVAR", &paths.texmf_var)
        .env("TEXMFCONFIG", &paths.texmf_config)
        .env("TEXMFCACHE", &paths.texmf_cache)
        .env("TEXMFOUTPUT", &paths.build)
        .env("SOURCE_DATE_EPOCH", source_epoch.to_string())
        .env("FORCE_SOURCE_DATE", "1")
        .env("TZ", "UTC")
        .env("LC_ALL", "C.UTF-8")
        .env("LANG", "C.UTF-8")
        .env("openin_any", "p")
        .env("openout_any", "p")
        .env("shell_escape", "f");
    if sandbox {
        command.env("TOSS_SANDBOX", "1");
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.kill_on_drop(true);
}

fn environment_arguments(source_epoch: i64) -> Vec<OsString> {
    let pairs = [
        ("HOME", "/job/home".to_string()),
        ("TMPDIR", "/job/tmp".to_string()),
        ("TEXMFHOME", "/job/texmf-home".to_string()),
        ("TEXMFVAR", "/job/texmf-var".to_string()),
        ("TEXMFCONFIG", "/job/texmf-config".to_string()),
        ("TEXMFCACHE", "/job/texmf-cache".to_string()),
        ("TEXMFOUTPUT", "/job/build".to_string()),
        ("SOURCE_DATE_EPOCH", source_epoch.to_string()),
        ("FORCE_SOURCE_DATE", "1".to_string()),
        ("TZ", "UTC".to_string()),
        ("LC_ALL", "C.UTF-8".to_string()),
        ("LANG", "C.UTF-8".to_string()),
        ("openin_any", "p".to_string()),
        ("openout_any", "p".to_string()),
        ("shell_escape", "f".to_string()),
    ];
    pairs
        .into_iter()
        .flat_map(|(name, value)| [OsString::from("--setenv"), name.into(), value.into()])
        .collect()
}

async fn run_command(
    mut command: Command,
    mut cancellation: watch::Receiver<bool>,
    wall_time: Duration,
) -> Result<CommandOutput, std::io::Error> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.kill_on_drop(true);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("compiler stdout was not captured"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("compiler stderr was not captured"))?;
    let stdout_task = tokio::spawn(drain_bounded(stdout, MAX_CAPTURE_BYTES));
    let stderr_task = tokio::spawn(drain_bounded(stderr, MAX_CAPTURE_BYTES));
    let outcome = tokio::select! {
        status = child.wait() => ProcessOutcome::Exited(status?),
        _ = tokio::time::sleep(wall_time) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            ProcessOutcome::TimedOut
        }
        changed = cancellation.changed() => {
            if changed.is_err() || *cancellation.borrow() {
                let _ = child.start_kill();
                let _ = child.wait().await;
                ProcessOutcome::Cancelled
            } else {
                let status = child.wait().await?;
                ProcessOutcome::Exited(status)
            }
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))??;
    let stderr = stderr_task
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))??;
    Ok(CommandOutput {
        outcome,
        stdout,
        stderr,
    })
}

async fn drain_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> Result<Vec<u8>, std::io::Error> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            return Ok(kept);
        }
        let remaining = limit.saturating_sub(kept.len());
        if remaining > 0 {
            let end = read.min(remaining);
            if let Some(chunk) = buffer.get(..end) {
                kept.extend_from_slice(chunk);
            }
        }
    }
}

fn load_diagnostic(
    paths: &JobPaths,
    options: &LatexOptions,
    output: &CommandOutput,
    max_bytes: i64,
) -> String {
    let stem = Path::new(&options.entry_file_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("main");
    let log_path = paths.build.join(format!("{stem}.log"));
    let raw = read_bounded(&log_path, max_bytes)
        .unwrap_or_else(|_| [output.stdout.as_slice(), output.stderr.as_slice()].concat());
    sanitize_diagnostic(&String::from_utf8_lossy(&raw), paths, max_bytes)
}

fn sanitize_diagnostic(value: &str, paths: &JobPaths, max_bytes: i64) -> String {
    let mut sanitized = value
        .replace(&paths.root.to_string_lossy().to_string(), "<job>")
        .replace("/job/work", "<project>")
        .replace("/job/build", "<build>")
        .replace("/runtime", "<runtime>")
        .replace("/opt/toss/latex-worker", "<runtime>")
        .replace("/usr/local/texlive", "<texlive>");
    let limit = usize::try_from(max_bytes.max(1)).unwrap_or(usize::MAX);
    if sanitized.len() > limit {
        let mut end = limit;
        while end > 0 && !sanitized.is_char_boundary(end) {
            end -= 1;
        }
        sanitized.truncate(end);
    }
    sanitized
}

fn read_bounded(path: &Path, max_bytes: i64) -> Result<Vec<u8>, std::io::Error> {
    let limit = u64::try_from(max_bytes.max(0)).unwrap_or(u64::MAX);
    let mut input = File::open(path)?;
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::FileTooLarge,
            "file exceeds configured limit",
        ));
    }
    Ok(bytes)
}

fn missing_dependency(diagnostic: &str) -> bool {
    diagnostic.contains("not found")
        && (diagnostic.contains("LaTeX Error: File") || diagnostic.contains("I can't find file"))
}

fn nonempty_diagnostic(value: String) -> String {
    if value.trim().is_empty() {
        "LaTeX compilation completed successfully.\n".to_string()
    } else {
        value
    }
}

fn invalid_input(code: &str, message: &str) -> ProcessorFailure {
    ProcessorFailure::new(WorkerFailureClass::InvalidInput, code, message)
}

fn io_failure(error: std::io::Error) -> ProcessorFailure {
    tracing::error!(?error, "LaTeX processor runtime failure");
    ProcessorFailure::new(
        WorkerFailureClass::TransientInfrastructure,
        "latex_runtime_failed",
        "The LaTeX runtime failed unexpectedly",
    )
}

#[cfg(test)]
mod tests {
    use super::{add_latexmk_arguments, missing_dependency, LatexOptions};
    use std::path::Path;
    use tokio::process::Command;

    #[test]
    fn missing_package_is_distinct_from_source_compile_error() {
        assert!(missing_dependency(
            "! LaTeX Error: File `missing.sty' not found."
        ));
        assert!(!missing_dependency("! Undefined control sequence."));
    }

    #[test]
    fn entry_path_cannot_be_parsed_as_a_latexmk_option() {
        let mut command = Command::new("latexmk");
        let options = LatexOptions {
            engine: "pdftex".to_string(),
            entry_file_path: "-main.tex".to_string(),
            source_epoch: 0,
        };
        add_latexmk_arguments(
            &mut command,
            &options,
            Path::new("/runtime/latexmkrc"),
            Path::new("/job/build"),
        );
        let arguments = command
            .as_std()
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(arguments.last().map(String::as_str), Some("./-main.tex"));
        assert!(!arguments.iter().any(|argument| argument == "--"));
    }
}
