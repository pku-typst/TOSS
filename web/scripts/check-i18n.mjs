import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const sourceRoot = path.join(webRoot, "src");
const catalogPath = path.join(sourceRoot, "lib", "i18n.ts");
const catalogSource = fs.readFileSync(catalogPath, "utf8");

function catalogSlice(startMarker, endMarker) {
  const start = catalogSource.indexOf(startMarker);
  const end = catalogSource.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Unable to locate i18n catalog section: ${startMarker}`);
  return catalogSource.slice(start + startMarker.length, end);
}

function messageKeys(source) {
  return [...source.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1]);
}

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

const englishKeys = messageKeys(catalogSlice("  en: {", '  "zh-CN": {'));
const chineseKeys = messageKeys(catalogSlice('  "zh-CN": {', "  }\n};"));
const englishSet = new Set(englishKeys);
const chineseSet = new Set(chineseKeys);
const failures = [];

for (const key of englishKeys) {
  if (!chineseSet.has(key)) failures.push(`Missing zh-CN translation: ${key}`);
}
for (const key of chineseKeys) {
  if (!englishSet.has(key)) failures.push(`Missing English translation: ${key}`);
}
for (const key of duplicates(englishKeys)) failures.push(`Duplicate English key: ${key}`);
for (const key of duplicates(chineseKeys)) failures.push(`Duplicate zh-CN key: ${key}`);

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target));
    else if (/\.tsx?$/.test(entry.name)) files.push(target);
  }
  return files;
}

const technicalText = new Set([
  "PDF",
  "XeTeX",
  "pdfTeX",
  "Online updates",
  "Typst Server"
]);
const userFacingAttributes = /\b(?:aria-label|title|placeholder|label)="([^"]*[A-Za-z\u3400-\u9fff][^"]*)"/g;
const directJsxText = /<[A-Za-z][^>]*>\s*([A-Za-z\u3400-\u9fff][A-Za-z0-9\u3400-\u9fff +./()_-]*)\s*</g;
const humanString = /(["'`])([A-Z][A-Za-z]+(?: [A-Za-z][A-Za-z0-9+./()_-]*)+)\1/g;

for (const file of sourceFiles(sourceRoot)) {
  const relative = path.relative(webRoot, file);
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/\b(?:t|translate)\(\s*["']([a-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+)["']/g)) {
    if (!englishSet.has(match[1])) failures.push(`${relative}: unknown translation key ${match[1]}`);
  }
  if (file === catalogPath || !file.endsWith(".tsx")) continue;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    for (const match of line.matchAll(userFacingAttributes)) {
      const value = match[1].trim();
      if (!technicalText.has(value) && !/^https?:\/\//.test(value)) {
        failures.push(`${relative}:${index + 1}: hard-coded user-facing attribute: ${value}`);
      }
    }
    for (const match of line.matchAll(directJsxText)) {
      const value = match[1].trim();
      if (!technicalText.has(value)) {
        failures.push(`${relative}:${index + 1}: hard-coded JSX text: ${value}`);
      }
    }
    for (const match of line.matchAll(humanString)) {
      const value = match[2].trim();
      if (!technicalText.has(value)) {
        failures.push(`${relative}:${index + 1}: suspicious hard-coded phrase: ${value}`);
      }
    }
    const previousLine = index > 0 ? lines[index - 1].trim() : "";
    if (
      /<[A-Za-z][^>]*>$/.test(previousLine) &&
      /^[A-Z][A-Za-z0-9 ,.'+()/-]*[.!?]?$/.test(trimmed) &&
      !technicalText.has(trimmed)
    ) {
      failures.push(`${relative}:${index + 1}: hard-coded multiline JSX text: ${trimmed}`);
    }
    if (/[\u3400-\u9fff]/.test(line)) {
      failures.push(`${relative}:${index + 1}: CJK text must come from the i18n catalog`);
    }
  }
}

if (/\b(?:throwApiError|parseJsonOrThrow)[\s\S]{0,120}["'](?:Unable to|Login failed|Registration failed)/.test(
  fs.readFileSync(path.join(sourceRoot, "lib", "api.ts"), "utf8")
)) {
  failures.push("src/lib/api.ts: API errors must use api.* translation keys");
}

if (failures.length > 0) {
  console.error(`[i18n] ${failures.length} issue(s) found:\n${failures.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}

console.log(`[i18n] catalogs aligned (${englishKeys.length} keys); no hard-coded UI copy found`);
