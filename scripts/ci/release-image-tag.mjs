import { pathToFileURL } from "node:url";

const RELEASES = Object.freeze({
  app: { prefix: "v" },
  "latex-worker": { prefix: "latex-worker-v" }
});

function validCoreIdentifier(identifier) {
  return /^(0|[1-9][0-9]*)$/.test(identifier);
}

function validPrereleaseIdentifier(identifier) {
  if (!/^[0-9A-Za-z-]+$/.test(identifier)) return false;
  return !/^[0-9]+$/.test(identifier) || validCoreIdentifier(identifier);
}

export function parseReleaseImageTag(release, tag) {
  const definition = RELEASES[release];
  if (!definition) throw new Error(`unknown image release: ${release}`);
  if (!tag.startsWith(definition.prefix)) {
    throw new Error(`${release} release tags must start with ${definition.prefix}`);
  }

  const version = tag.slice(definition.prefix.length);
  if (version.includes("+")) {
    throw new Error("image release tags do not support SemVer build metadata");
  }

  const separator = version.indexOf("-");
  const core = separator === -1 ? version : version.slice(0, separator);
  const prerelease = separator === -1 ? null : version.slice(separator + 1);
  const coreIdentifiers = core.split(".");
  if (coreIdentifiers.length !== 3 || !coreIdentifiers.every(validCoreIdentifier)) {
    throw new Error(`invalid SemVer core: ${version}`);
  }
  if (
    prerelease !== null &&
    (prerelease.length === 0 || !prerelease.split(".").every(validPrereleaseIdentifier))
  ) {
    throw new Error(`invalid SemVer prerelease: ${version}`);
  }

  return { version, stable: prerelease === null };
}

function main() {
  const [, , release, tag] = process.argv;
  const metadata = parseReleaseImageTag(release, tag);
  process.stdout.write(`version=${metadata.version}\nstable=${metadata.stable}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
