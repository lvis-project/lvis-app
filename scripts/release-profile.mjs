/**
 * Verify the immutable unsigned public-release profile carried by a tag.
 * This module intentionally does not control workflow secrets or release-body
 * paths: public tag safety is fixed by the reviewed workflow itself.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

function fail(message) {
  throw new Error("[release-profile-invalid] " + message);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(label + " must be a non-empty string");
  }
  return value;
}

/**
 * Public tag release is deliberately unsigned until a separately reviewed
 * signing/notarization workflow and evidence gate exists. workflow_dispatch is
 * a secret-free internal candidate and does not publish a GitHub Release.
 */
export function resolveReleaseProfile({ eventName, refName, sourceSha, packageJson }) {
  if (eventName === "workflow_dispatch") {
    return {
      distributionChannel: "internal",
      signingMode: "internal-candidate",
    };
  }

  if (eventName !== "push") {
    fail("unsupported event " + JSON.stringify(eventName));
  }

  const source = requireString(sourceSha, "immutable source SHA");
  if (!COMMIT_SHA.test(source)) {
    fail("immutable source SHA must be 40 lowercase hexadecimal characters");
  }

  const tag = requireString(refName, "tag ref name");
  const tagMatch = /^v(\d+\.\d+\.\d+)$/u.exec(tag);
  if (!tagMatch) {
    fail("tag ref name must be vX.Y.Z, got " + JSON.stringify(tag));
  }

  const version = requireString(packageJson?.version, "package.json#version");
  if (!VERSION.test(version)) {
    fail("package.json#version must be X.Y.Z, got " + JSON.stringify(version));
  }
  if (tagMatch[1] !== version) {
    fail("tag " + tag + " must match package.json version " + version);
  }

  const release = packageJson?.lvisRelease;
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    fail("package.json#lvisRelease must be an object for a public tag");
  }
  if (release.tagDistribution !== "public") {
    fail("package.json#lvisRelease.tagDistribution must be public for a tag");
  }
  if (release.signing !== "unsigned") {
    fail("package.json#lvisRelease.signing must be unsigned until signed release evidence is implemented");
  }

  return {
    distributionChannel: "public",
    signingMode: "unsigned",
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option || !option.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("expected --event-name, --ref-name, and --source-sha option pairs");
    }
    const name = option.slice(2);
    if (!["event-name", "ref-name", "source-sha"].includes(name) || options[name] !== undefined) {
      fail("unsupported or duplicate option " + JSON.stringify(option));
    }
    options[name] = value;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = resolveReleaseProfile({
    eventName: options["event-name"],
    refName: options["ref-name"],
    sourceSha: options["source-sha"],
    packageJson: JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")),
  });
  console.log(
    "[release-profile] distribution=" + profile.distributionChannel +
      " signing=" + profile.signingMode,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
