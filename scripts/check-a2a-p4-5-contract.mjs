import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const blueprintPath = resolve(root, "docs/blueprints/a2a-subagent-messaging.md");
const specPath = resolve(root, "docs/protocols/lvis-a2a-exact-send-replay.md");
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

function isInsideRoot(base, candidate, pathApi) {
  const fromBase = pathApi.relative(base, candidate);
  return (
    fromBase === "" ||
    (fromBase !== ".." && !fromBase.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(fromBase))
  );
}

function validateContainmentPortability() {
  const windowsRoot = "C:\\repo";
  if (!isInsideRoot(windowsRoot, "C:\\repo\\docs\\contract.md", win32)) {
    fail("Windows containment self-test rejected an in-repository path");
  }
  if (isInsideRoot(windowsRoot, "C:\\repo-escape\\contract.md", win32)) {
    fail("Windows containment self-test accepted a sibling-prefix escape");
  }
  if (isInsideRoot(windowsRoot, "D:\\other\\contract.md", win32)) {
    fail("Windows containment self-test accepted a cross-drive escape");
  }
}

function validateLocalLinks(path, text) {
  const links = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  let checked = 0;
  for (const raw of links) {
    if (/^(?:https?:|mailto:)/i.test(raw) || raw.startsWith("#")) continue;
    const target = raw.split("#", 1)[0];
    if (target.length === 0) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      fail(`${path}: malformed percent-encoding in local link: ${raw}`);
    }
    const absolute = resolve(dirname(path), decoded);
    if (!isInsideRoot(root, absolute, { relative, isAbsolute, sep })) {
      fail(`${path}: local link escapes repository: ${raw}`);
    }
    if (!existsSync(absolute)) fail(`${path}: broken local link: ${raw}`);
    checked += 1;
  }
  return checked;
}

function requireExactErrorContracts(text) {
  const jsonBlocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match, index) => {
    try {
      return JSON.parse(match[1]);
    } catch (error) {
      fail(`spec JSON block ${index + 1} is invalid: ${error.message}`);
    }
  });
  const expected = [
    [-32090, "Exact send replay conflict", "EXACT_SEND_REPLAY_CONFLICT"],
    [-32091, "Exact send replay retention expired", "EXACT_SEND_REPLAY_RETENTION_EXPIRED"],
    [-32092, "Exact send replay in progress", "EXACT_SEND_REPLAY_IN_PROGRESS", { retryAfterSeconds: "1" }],
    [-32093, "Exact send replay outcome unknown", "EXACT_SEND_REPLAY_OUTCOME_UNKNOWN"],
    [-32094, "Exact send replay capacity exhausted", "EXACT_SEND_REPLAY_CAPACITY_EXHAUSTED"],
  ];
  const seen = new Set();
  for (const [code, message, reason, metadata] of expected) {
    const matches = jsonBlocks.filter((block) => block?.code === code);
    if (matches.length !== 1) fail(`expected exactly one JSON error contract for ${code}`);
    const block = matches[0];
    if (seen.has(block.code)) fail(`duplicate JSON error code ${block.code}`);
    seen.add(block.code);
    if (block.message !== message) fail(`${code}: unexpected message`);
    if (!Array.isArray(block.data) || block.data.length !== 1) {
      fail(`${code}: data must be a one-element A2A v1 array`);
    }
    const detail = block.data[0];
    if (
      detail?.["@type"] !== "type.googleapis.com/google.rpc.ErrorInfo" ||
      detail.reason !== reason ||
      detail.domain !== "lvis.ai"
    ) {
      fail(`${code}: unexpected google.rpc.ErrorInfo detail`);
    }
    if (JSON.stringify(detail.metadata) !== JSON.stringify(metadata)) {
      fail(`${code}: unexpected ErrorInfo metadata`);
    }
  }
}

const blueprint = readRequired(blueprintPath);
const spec = readRequired(specPath);
const p45Start = blueprint.indexOf("#### P4-5 / G005 direct remote-routing contract");
const p45End = blueprint.indexOf("## Cross-host implementation review", p45Start);
if (p45Start < 0 || p45End < 0) fail("cannot isolate the P4-5 blueprint section");
const p45 = blueprint.slice(p45Start, p45End);
const normalizedP45 = p45.replace(/\s+/g, " ");
validateContainmentPortability();

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
  ["explicit two-stage transaction", "two-stage journal"],
  ["absent, not null placeholders", "prepared stage snapshot exclusion"],
  ["at the earlier of settlement or its bounded", "encrypted payload deletion boundary"],
  ["lost before that durable commit is not settled", "lost response retention"],
  ["foreground approval is required because neither creates", "existing-operation prompt-free recovery"],
  ["Every new `SendMessage`, continuation, or live `CancelTask`", "new mutation reapproval"],
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
  ["EXACT_SEND_REPLAY_CONFLICT", "conflict error"],
  ["EXACT_SEND_REPLAY_RETENTION_EXPIRED", "retention error"],
  ["EXACT_SEND_REPLAY_IN_PROGRESS", "in-progress error"],
  ["EXACT_SEND_REPLAY_OUTCOME_UNKNOWN", "outcome-unknown error"],
  ["EXACT_SEND_REPLAY_CAPACITY_EXHAUSTED", "capacity error"],
  ["Retry-After: 1", "fixed retry-after"],
  ["maps it to `reconciling`", "in-progress client mapping"],
  ["unknown-manual-reconciliation-required", "outcome-unknown client mapping"],
  ["capacity-manual-intervention-required", "capacity client mapping"],
  ["immutable caller-generation token", "caller generation"],
  ["durable non-sensitive tombstone", "post-retention tombstone"],
  ["never evicted to admit a new key", "no tombstone eviction"],
  ["same external subject later enrolls again", "re-enrollment generation isolation"],
  ["A one-entry quota accepts no new replay key", "capacity conformance vector"],
  ["Every custom error uses the exact numeric code", "error conformance vector"],
  ["Authentication and ordinary A2A authorization MUST complete", "auth ordering"],
  ["Required conformance vectors", "wire vectors"],
  [officialSpec, "official specification pin"],
]) {
  requireText(spec, needle, label);
}
requireExactErrorContracts(spec);

const linkCount = validateLocalLinks(blueprintPath, blueprint) + validateLocalLinks(specPath, spec);
if (linkCount < 2) fail(`expected at least two checked local links, got ${linkCount}`);

console.log(
  `[a2a-p4-5-contract] PASS blueprint_sha256=${sha256(blueprint)} spec_sha256=${sha256(spec)} local_links=${linkCount}`,
);
