import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback, constants } from "node:zlib";

const DIST_DIR = path.resolve("dist");
const MIN_SOURCE_BYTES = 1_024;
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".data",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
  ".xml"
]);
const gzip = promisify(gzipCallback);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(target) : [target];
    })
  );
  return nested.flat();
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const files = await listFiles(DIST_DIR);
let sourceBytes = 0;
let compressedBytes = 0;
let written = 0;

for (const file of files) {
  if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(file))) continue;
  const destination = `${file}.gz`;
  if (await exists(destination)) continue;
  const source = await readFile(file);
  if (source.byteLength < MIN_SOURCE_BYTES) continue;
  const compressed = await gzip(source, { level: constants.Z_BEST_COMPRESSION });
  if (compressed.byteLength >= source.byteLength) continue;
  await writeFile(destination, compressed);
  sourceBytes += source.byteLength;
  compressedBytes += compressed.byteLength;
  written += 1;
}

const ratio = sourceBytes > 0 ? Math.round((compressedBytes / sourceBytes) * 100) : 0;
console.log(
  `[precompress] wrote ${written} gzip assets (${Math.round(sourceBytes / 1024)} KiB -> ${Math.round(compressedBytes / 1024)} KiB, ${ratio}%)`
);
