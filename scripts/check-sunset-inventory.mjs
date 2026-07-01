#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const args = process.argv.slice(2);
const fileArgIndex = args.indexOf("--file");
const inventoryPath =
  fileArgIndex >= 0 && typeof args[fileArgIndex + 1] === "string"
    ? resolve(repoRoot, args[fileArgIndex + 1])
    : resolve(repoRoot, "docs/development/legacy-sunset-inventory.json");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(["migration", "legacy-compatibility", "dormant-experimental"]);
const STATUSES = new Set(["active", "experimental-isolated"]);

function fail(message) {
  console.error(`[sunset-inventory] ${message}`);
  process.exitCode = 1;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function assertDate(entryId, field, value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    fail(`${entryId}: ${field} must be YYYY-MM-DD`);
  }
}

function assertExistingPaths(entryId, field, paths) {
  if (!Array.isArray(paths)) {
    fail(`${entryId}: ${field} must be an array`);
    return;
  }
  for (const rel of paths) {
    if (typeof rel !== "string" || rel.length === 0) {
      fail(`${entryId}: ${field} contains an empty or non-string path`);
      continue;
    }
    if (rel.includes("\\") || rel.startsWith("/") || rel.includes("..")) {
      fail(`${entryId}: ${field} path must be repo-relative POSIX style: ${rel}`);
      continue;
    }
    if (!existsSync(resolve(repoRoot, rel))) {
      fail(`${entryId}: ${field} path does not exist: ${rel}`);
    }
  }
}

function assertStringArray(entryId, field, value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    fail(`${entryId}: ${field} must be a non-empty string array`);
  }
}

function validateEntry(entry) {
  if (!entry || typeof entry !== "object") {
    fail("entries must contain objects");
    return;
  }
  const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : "<missing-id>";
  for (const field of ["id", "owner", "introduced", "introducedBy", "rationale"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      fail(`${id}: missing required string field ${field}`);
    }
  }
  if (!KINDS.has(entry.kind)) fail(`${id}: unsupported kind ${entry.kind}`);
  if (!STATUSES.has(entry.status)) fail(`${id}: unsupported status ${entry.status}`);
  assertDate(id, "introduced", entry.introduced);
  assertExistingPaths(id, "codeReferences", entry.codeReferences);
  assertExistingPaths(id, "dataPreservationTests", asArray(entry.dataPreservationTests));
  assertStringArray(id, "validation", entry.validation);
  assertStringArray(id, "sunsetCriteria", entry.sunsetCriteria);

  if (entry.kind === "migration") {
    assertDate(id, "sunsetNotBefore", entry.sunsetNotBefore);
    if (asArray(entry.dataPreservationTests).length === 0) {
      fail(`${id}: migrations require at least one dataPreservationTests path`);
    }
  }

  if (entry.status === "experimental-isolated") {
    const codeReferences = asArray(entry.codeReferences);
    const hasExperimentalPath = codeReferences.some((path) => path.includes("/experimental/"));
    const hasFeatureFlag = typeof entry.featureFlag === "string" && entry.featureFlag.length > 0;
    if (!hasExperimentalPath && !hasFeatureFlag) {
      fail(`${id}: experimental-isolated entries need an experimental/ path or featureFlag`);
    }
    assertDate(id, "reviewAfter", entry.reviewAfter);
    assertDate(id, "deleteOrPromoteAfter", entry.deleteOrPromoteAfter);
  }
}

let inventory;
try {
  inventory = JSON.parse(readFileSync(inventoryPath, "utf-8"));
} catch (err) {
  fail(`failed to read ${inventoryPath}: ${err.message}`);
  process.exit();
}

if (inventory.schemaVersion !== 1) fail("schemaVersion must be 1");
assertDate("inventory", "lastReviewed", inventory.lastReviewed);
if (typeof inventory.minSupportedAppVersion !== "string" || inventory.minSupportedAppVersion.length === 0) {
  fail("minSupportedAppVersion is required");
}
if (!inventory.policy || typeof inventory.policy !== "object") {
  fail("policy is required");
}
if (!Array.isArray(inventory.entries) || inventory.entries.length === 0) {
  fail("entries must be a non-empty array");
}

const ids = new Set();
for (const entry of asArray(inventory.entries)) {
  if (ids.has(entry.id)) fail(`duplicate entry id: ${entry.id}`);
  ids.add(entry.id);
  validateEntry(entry);
}

if (process.exitCode) process.exit();
console.log(`[sunset-inventory] OK entries=${inventory.entries.length}`);
