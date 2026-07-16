import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const blueprintPath = resolve(root, "docs/blueprints/a2a-subagent-messaging.md");
const specPath = resolve(root, "docs/protocols/lvis-a2a-exact-send-replay-v1.md");
const extensionUri = "https://lvis.ai/a2a/extensions/exact-send-replay/v1";
const officialSpec = "https://a2a-protocol.org/v1.0.0/specification/";

function fail(message) {
  throw new Error(`[a2a-p4-5-contract] ${message}`);
}

function readRequired(path) {
  if (!existsSync(path)) fail(`missing file: ${path}`);
  return readFileSync(path, "utf8");
}

function requireText(text, needle, label) {
  if (!text.includes(needle)) fail(`${label}: missing ${JSON.stringify(needle)}`);
}

function requireOrdered(text, needles, label) {
  let cursor = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, cursor + 1);
    if (next < 0) fail(`${label}: missing ordered step ${JSON.stringify(needle)}`);
    if (next <= cursor) fail(`${label}: out-of-order step ${JSON.stringify(needle)}`);
    cursor = next;
  }
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function validateLocalLinks(path, text) {
  const links = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  let checked = 0;
  for (const raw of links) {
    if (/^(?:https?:|mailto:)/i.test(raw) || raw.startsWith("#")) continue;
    const target = raw.split("#", 1)[0];
    if (target.length === 0) continue;
    const decoded = decodeURIComponent(target);
    const absolute = resolve(dirname(path), decoded);
    if (!absolute.startsWith(`${root}/`) && absolute !== root) {
      fail(`${path}: local link escapes repository: ${raw}`);
    }
    if (!existsSync(absolute)) fail(`${path}: broken local link: ${raw}`);
    checked += 1;
  }
  return checked;
}

const blueprint = readRequired(blueprintPath);
const spec = readRequired(specPath);
const p45Start = blueprint.indexOf("#### P4-5 / G005 direct remote-routing contract");
const p45End = blueprint.indexOf("## Cross-host implementation review", p45Start);
if (p45Start < 0 || p45End < 0) fail("cannot isolate the P4-5 blueprint section");
const p45 = blueprint.slice(p45Start, p45End);
const normalizedP45 = p45.replace(/\s+/g, " ");

for (const [needle, label] of [
  [extensionUri, "extension URI"],
  [officialSpec, "immutable A2A v1.0 specification"],
  ["D8 remains depth-1", "D8 hard stop"],
  ["Plugin/HostApi integration", "plugin exclusion"],
  ["at most 16 entries", "P4-1 extension count bound"],
  ["Parameters are bounded to 4,096 canonical UTF-8 bytes", "P4-1 params byte bound"],
  ["depth 4, 64 total values, 32 members per object or items per array", "P4-1 params structural bounds"],
  ["only declaration", "health evidence boundary"],
  ["`AUTH_REQUIRED` MUST include a `TaskStatus.message`", "AUTH_REQUIRED message"],
  ["server MAY continue processing without a follow-up Message", "AUTH_REQUIRED automatic continuation"],
  ["`TaskNotFoundError`", "TaskNotFound behavior"],
  ["`TaskNotCancelableError`", "TaskNotCancelable behavior"],
  ["`historyLength` follows A2A v1.0 exactly", "GetTask historyLength"],
  ["Deterministic local", "deterministic local gate"],
  ["SQLite + PostgreSQL", "database parity gate"],
  ["Cross-repo pinned-head wire vectors", "wire gate"],
  ["Packaged live", "packaged live gate"],
  ["official `a2aproject/a2a-tck` release/tag and full commit", "TCK pin"],
]) {
  requireText(p45, needle, label);
}

requireOrdered(
  normalizedP45,
  [
    "pass host authorization",
    "visible foreground `agent-action` approval",
    "OS-bound encrypted payload store",
    "prepared metadata-journal intent commits",
    "OS-safe local resolver",
    "final authenticated no-store route resolve",
    "CAS-attaches the complete snapshot ID",
    "data-plane socket starts immediately",
  ],
  "new-mutation security order",
);

for (const [needle, label] of [
  [extensionUri, "canonical URI"],
  ["RFC 2119 and", "requirements language"],
  ["`A2A-Extensions`", "request activation header"],
  ["The server MUST echo exactly the activated URI", "response activation echo"],
  ["same authenticated caller", "caller identity match"],
  ["byte-for-byte identical serialized body", "exact body match"],
  ["identical body SHA-256", "body hash match"],
  ["same union kind and durable identity", "durable Message or Task identity"],
  ["exact-send-replay-conflict", "conflict error"],
  ["exact-send-replay-retention-expired", "retention error"],
  ["Authentication and ordinary A2A authorization MUST complete", "auth ordering"],
  ["Required conformance vectors", "wire vectors"],
  [officialSpec, "official specification pin"],
]) {
  requireText(spec, needle, label);
}

const linkCount = validateLocalLinks(blueprintPath, blueprint) + validateLocalLinks(specPath, spec);
if (linkCount < 2) fail(`expected at least two checked local links, got ${linkCount}`);

console.log(
  `[a2a-p4-5-contract] PASS blueprint_sha256=${sha256(blueprint)} spec_sha256=${sha256(spec)} local_links=${linkCount}`,
);
