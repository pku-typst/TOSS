import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const sourceRoot = path.join(repoRoot, "third-party", "typst.ts");
const outputRoot = path.join(repoRoot, "prebuilt", "typst-compiler");
const packageRoot = path.join(outputRoot, "package");
const manifestPath = path.join(outputRoot, "build-manifest.json");
const builderDockerfile = path.join(repoRoot, "scripts", "typst-compiler-builder.Dockerfile");
const runtimeConfigPath = path.join(repoRoot, "web", "typst-runtime.config.json");
const compilerPackageName = "@myriaddreamin/typst-ts-web-compiler";
const lfsPointerPrefix = "version https://git-lfs.github.com/spec/v1";

const requiredPackageFiles = [
  "package.json",
  "pkg/README.md",
  "pkg/package.json",
  "pkg/typst_ts_web_compiler.d.ts",
  "pkg/typst_ts_web_compiler.mjs",
  "pkg/typst_ts_web_compiler_bg.wasm",
  "pkg/typst_ts_web_compiler_bg.wasm.d.ts",
  "pkg/wasm-pack-shim.d.mts",
  "pkg/wasm-pack-shim.mjs"
];

function fail(message) {
  throw new Error(message);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function capture(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
  return stdout.trim();
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: repoRoot });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code ?? signal}`));
      }
    });
  });
}

async function sourceRevision() {
  return capture("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
}

async function listPackageFiles(dir = packageRoot, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listPackageFiles(absolute, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      fail(`Prebuilt compiler package contains a non-file entry: ${relative}`);
    }
  }
  return files;
}

async function fileRecord(relativePath) {
  const absolute = path.join(packageRoot, ...relativePath.split("/"));
  const content = await fs.readFile(absolute);
  return {
    sha256: sha256(content),
    size_bytes: content.byteLength
  };
}

async function normalizeTextPackageFiles(root) {
  for (const relativePath of requiredPackageFiles) {
    if (relativePath.endsWith(".wasm")) continue;
    const filePath = path.join(root, ...relativePath.split("/"));
    const text = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, `${text.replace(/[\t \r\n]*$/u, "")}\n`);
  }
}

function dockerfileImage(dockerfile, stage) {
  const escaped = stage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = dockerfile.match(new RegExp(`^FROM\\s+(\\S+)\\s+AS\\s+${escaped}\\s*$`, "mi"));
  if (!match) fail(`Builder Dockerfile does not define stage ${stage}`);
  return match[1];
}

async function dockerVersion(image, entrypoint, args) {
  return capture("docker", ["run", "--rm", "--entrypoint", entrypoint, image, ...args]);
}

async function buildCompiler() {
  const runtimeConfig = await readJson(runtimeConfigPath);
  const revision = await sourceRevision();
  if (runtimeConfig.compiler?.source_revision !== revision) {
    fail(
      `Typst runtime config expects ${runtimeConfig.compiler?.source_revision || "no revision"}, ` +
        `but the submodule is ${revision}`
    );
  }
  const dirty = await capture("git", ["-C", sourceRoot, "status", "--short", "--untracked-files=no"]);
  if (dirty) fail(`Refusing to build from a dirty typst.ts submodule:\n${dirty}`);

  const builderTag = `toss-typst-compiler-builder:${revision.slice(0, 12)}`;
  await run("docker", [
    "build",
    "--progress=plain",
    "--file",
    builderDockerfile,
    "--target",
    "compiler-builder",
    "--tag",
    builderTag,
    repoRoot
  ]);

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "toss-typst-compiler-"));
  const temporaryPackage = path.join(temporaryRoot, "package");
  let containerId = "";
  try {
    await fs.mkdir(temporaryPackage, { recursive: true });
    containerId = await capture("docker", ["create", builderTag]);
    await run("docker", [
      "cp",
      `${containerId}:/src/typst.ts/packages/compiler/package.json`,
      path.join(temporaryPackage, "package.json")
    ]);
    await run("docker", [
      "cp",
      `${containerId}:/src/typst.ts/packages/compiler/pkg`,
      path.join(temporaryPackage, "pkg")
    ]);
    await fs.rm(path.join(temporaryPackage, "pkg", ".gitignore"), { force: true });
    await normalizeTextPackageFiles(temporaryPackage);

    await fs.rm(packageRoot, { recursive: true, force: true });
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.cp(temporaryPackage, packageRoot, { recursive: true });

    const dockerfile = await fs.readFile(builderDockerfile, "utf8");
    const packageJson = await readJson(path.join(packageRoot, "package.json"));
    const files = {};
    for (const relativePath of await listPackageFiles()) {
      files[relativePath] = await fileRecord(relativePath);
    }

    const manifest = {
      schema: 1,
      source_revision: revision,
      package_name: packageJson.name,
      package_version: packageJson.version,
      generator: {
        path: path.relative(repoRoot, scriptPath),
        sha256: await sha256File(scriptPath)
      },
      builder: {
        dockerfile: path.relative(repoRoot, builderDockerfile),
        dockerfile_sha256: sha256(dockerfile),
        node_image: dockerfileImage(dockerfile, "node-runtime"),
        rust_image: dockerfileImage(dockerfile, "compiler-builder"),
        node_version: await dockerVersion(builderTag, "node", ["--version"]),
        rustc_version: await dockerVersion(builderTag, "rustc", ["--version"]),
        cargo_version: await dockerVersion(builderTag, "cargo", ["--version"]),
        wasm_pack_version: await dockerVersion(builderTag, "wasm-pack", ["--version"]),
        wasm_opt_version: await dockerVersion(builderTag, "sh", [
          "-c",
          "find /root/.cache/.wasm-pack -type f -name wasm-opt -exec {} --version \\; | head -1"
        ]),
        wasm_pack_target: "web",
        cargo_features: ["web", "misc"]
      },
      files
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    if (containerId) {
      await execFileAsync("docker", ["rm", "--force", containerId], { cwd: repoRoot }).catch(() => {});
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }

  await verifyCompiler();
  process.stdout.write(`[typst-compiler] generated ${path.relative(repoRoot, outputRoot)}\n`);
}

async function verifyCompiler({ verifySource = true } = {}) {
  const [manifest, runtimeConfig, packageJson, dockerfile] = await Promise.all([
    readJson(manifestPath),
    readJson(runtimeConfigPath),
    readJson(path.join(packageRoot, "package.json")),
    fs.readFile(builderDockerfile, "utf8")
  ]);
  const revision = verifySource ? await sourceRevision() : manifest.source_revision;
  if (manifest.schema !== 1) fail("Unsupported prebuilt compiler manifest schema");
  if (
    manifest.generator?.path !== path.relative(repoRoot, scriptPath) ||
    manifest.generator?.sha256 !== (await sha256File(scriptPath))
  ) {
    fail("Prebuilt compiler generator changed; regenerate the package");
  }
  if (manifest.source_revision !== revision) {
    fail(`Prebuilt compiler source ${manifest.source_revision} does not match submodule ${revision}`);
  }
  if (runtimeConfig.compiler?.source_revision !== revision) {
    fail(`Typst runtime config does not match compiler source ${revision}`);
  }
  if (
    packageJson.name !== compilerPackageName ||
    manifest.package_name !== compilerPackageName ||
    packageJson.version !== manifest.package_version ||
    packageJson.version !== runtimeConfig.compiler?.package_version
  ) {
    fail("Prebuilt compiler package metadata does not match typst-runtime.config.json");
  }
  if (manifest.builder?.dockerfile !== path.relative(repoRoot, builderDockerfile)) {
    fail("Prebuilt compiler manifest points at an unexpected builder Dockerfile");
  }
  if (manifest.builder?.dockerfile_sha256 !== sha256(dockerfile)) {
    fail("Builder Dockerfile changed; regenerate the prebuilt compiler package");
  }
  if (
    manifest.builder?.node_image !== dockerfileImage(dockerfile, "node-runtime") ||
    manifest.builder?.rust_image !== dockerfileImage(dockerfile, "compiler-builder")
  ) {
    fail("Builder image provenance does not match the pinned Dockerfile");
  }

  const actualFiles = await listPackageFiles();
  const expectedFiles = [...requiredPackageFiles].sort();
  const sortedActualFiles = [...actualFiles].sort();
  if (JSON.stringify(sortedActualFiles) !== JSON.stringify(expectedFiles)) {
    fail(
      `Unexpected prebuilt compiler package files:\nexpected=${expectedFiles.join(",")}\n` +
        `actual=${sortedActualFiles.join(",")}`
    );
  }
  if (
    JSON.stringify(Object.keys(manifest.files || {}).sort()) !== JSON.stringify(sortedActualFiles)
  ) {
    fail("Prebuilt compiler manifest file list is incomplete or stale");
  }

  for (const relativePath of actualFiles) {
    const absolute = path.join(packageRoot, ...relativePath.split("/"));
    const content = await fs.readFile(absolute);
    if (content.subarray(0, lfsPointerPrefix.length).toString("utf8") === lfsPointerPrefix) {
      fail(`${relativePath} is a Git LFS pointer; run git lfs pull`);
    }
    const expected = manifest.files[relativePath];
    if (content.byteLength !== expected.size_bytes || sha256(content) !== expected.sha256) {
      fail(`${relativePath} does not match its recorded size and SHA-256`);
    }
  }

  const compilerTypes = await fs.readFile(
    path.join(packageRoot, "pkg", "typst_ts_web_compiler.d.ts"),
    "utf8"
  );
  for (const symbol of ["mapping_revision", "source_to_document", "document_to_source"]) {
    if (!compilerTypes.includes(symbol)) fail(`Prebuilt compiler is missing ${symbol}`);
  }

  process.stdout.write(
    `[typst-compiler] verified ${manifest.package_name}@${manifest.package_version} ` +
      `${manifest.source_revision.slice(0, 8)} (${manifest.files["pkg/typst_ts_web_compiler_bg.wasm"].size_bytes} bytes)\n`
  );
}

const command = process.argv[2] || "verify";
try {
  if (command === "build") {
    await buildCompiler();
  } else if (command === "verify") {
    await verifyCompiler();
  } else if (command === "verify-package") {
    await verifyCompiler({ verifySource: false });
  } else {
    fail("Usage: node scripts/prebuilt-typst-compiler.mjs <build|verify|verify-package>");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
