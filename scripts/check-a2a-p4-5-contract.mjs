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

function rejectText(text, needle, label) {
  if (text.includes(needle)) fail(`${label}: forbidden ${JSON.stringify(needle)}`);
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

function decodeLinkTarget(target) {
  try {
    return { ok: true, value: decodeURIComponent(target) };
  } catch {
    return { ok: false };
  }
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
  if (decodeLinkTarget("%ZZ").ok) {
    fail("malformed percent-encoding self-test was accepted");
  }
  const traversal = decodeLinkTarget("%2e%2e%5c%2e%2e%5cescape.md");
  if (!traversal.ok) fail("encoded traversal self-test did not decode");
  const escaped = win32.resolve(windowsRoot, "docs", traversal.value);
  if (isInsideRoot(windowsRoot, escaped, win32)) {
    fail("Windows containment self-test accepted encoded traversal");
  }
}

function validateLocalLinks(path, text) {
  const links = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  let checked = 0;
  for (const raw of links) {
    if (/^(?:https?:|mailto:)/i.test(raw) || raw.startsWith("#")) continue;
    const target = raw.split("#", 1)[0];
    if (target.length === 0) continue;
    const decoded = decodeLinkTarget(target);
    if (!decoded.ok) {
      fail(`${path}: malformed percent-encoding in local link: ${raw}`);
    }
    const absolute = resolve(dirname(path), decoded.value);
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
    const matches = jsonBlocks.filter((block) => block?.error?.code === code);
    if (matches.length !== 1) fail(`expected exactly one JSON error contract for ${code}`);
    const envelope = matches[0];
    if (JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(["error", "id", "jsonrpc"])) {
      fail(`${code}: response must be a full JSON-RPC error envelope`);
    }
    if (envelope.jsonrpc !== "2.0" || envelope.id !== "<exact request id>") {
      fail(`${code}: envelope must preserve the exact request id marker`);
    }
    const block = envelope.error;
    if (JSON.stringify(Object.keys(block).sort()) !== JSON.stringify(["code", "data", "message"])) {
      fail(`${code}: error member has unexpected fields`);
    }
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
    const expectedDetailKeys = metadata
      ? ["@type", "domain", "metadata", "reason"]
      : ["@type", "domain", "reason"];
    if (JSON.stringify(Object.keys(detail).sort()) !== JSON.stringify(expectedDetailKeys)) {
      fail(`${code}: ErrorInfo has unexpected fields`);
    }
  }
}

function requireExactSuccessContracts(text) {
  const jsonBlocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match, index) => {
    try {
      return JSON.parse(match[1]);
    } catch (error) {
      fail(`spec JSON block ${index + 1} is invalid: ${error.message}`);
    }
  });
  const envelopes = jsonBlocks.filter((block) => block?.result !== undefined);
  if (envelopes.length !== 2) fail("expected exactly two JSON success-envelope contracts");
  const branches = new Set();
  for (const envelope of envelopes) {
    if (JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(["id", "jsonrpc", "result"])) {
      fail("success response must be a full JSON-RPC result envelope");
    }
    if (envelope.jsonrpc !== "2.0" || envelope.id !== "<exact request id>") {
      fail("success envelope must preserve the exact request id marker");
    }
    const resultKeys = Object.keys(envelope.result);
    if (resultKeys.length !== 1 || !["message", "task"].includes(resultKeys[0])) {
      fail("SendMessageResponse result must contain exactly one message or task branch");
    }
    branches.add(resultKeys[0]);
  }
  if (!branches.has("message") || !branches.has("task")) {
    fail("success contracts must cover both SendMessageResponse branches");
  }
}

function requireExactAgentExtensionContract(text) {
  const jsonBlocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match, index) => {
    try {
      return JSON.parse(match[1]);
    } catch (error) {
      fail(`spec JSON block ${index + 1} is invalid: ${error.message}`);
    }
  });
  const declarations = jsonBlocks.filter((block) => block?.uri === extensionUri);
  if (declarations.length !== 1) fail("expected exactly one canonical Agent Card declaration");
  const declaration = declarations[0];
  if (
    JSON.stringify(Object.keys(declaration).sort()) !==
    JSON.stringify(["description", "params", "required", "uri"])
  ) {
    fail("Agent Card extension declaration has unexpected fields");
  }
  if (declaration.required !== false) {
    fail("Agent Card extension declaration must use required: false");
  }
  const expectedParams = {
    profile: "lvis-exact-send-replay",
    profileVersion: "1",
    requestBody: "exact-serialized-jsonrpc",
    resultRetentionSeconds: "604800",
    specDigestSha256: "<64 lowercase hexadecimal characters>",
  };
  if (JSON.stringify(declaration.params) !== JSON.stringify(expectedParams)) {
    fail("Agent Card extension declaration has unexpected params");
  }
}

const blueprint = readRequired(blueprintPath);
const spec = readRequired(specPath);
const p45Start = blueprint.indexOf("#### P4-5 / G005 direct remote-routing contract");
const p45End = blueprint.indexOf("## Cross-host implementation review", p45Start);
if (p45Start < 0 || p45End < 0) fail("cannot isolate the P4-5 blueprint section");
const p45 = blueprint.slice(p45Start, p45End);
const normalizedP45 = p45.replace(/\s+/g, " ");
const normalizedSpec = spec.replace(/\s+/g, " ");
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
  ["at the earlier of client-observed", "encrypted payload deletion boundary"],
  ["lost before that durable commit is not settled", "lost response retention"],
  ["foreground approval is required because neither creates", "existing-operation prompt-free recovery"],
  ["Every new initial `SendMessage`, continuation `SendMessage`, or live", "new mutation reapproval"],
  ["prepared metadata-journal intent for every mutation", "universal metadata preparation"],
  ["for an initial Send only, the exact serialized body", "initial-only encrypted body"],
  ["never stores a raw/encrypted body or payload pointer", "continuation cancel no body pointer"],
  ["For an initial Send only, failed-preparation and orphan cleanup", "initial-only failed preparation cleanup"],
  ["non-sendable `staged`", "staged encrypted payload"],
  ["One durable transaction then creates", "payload-journal atomic binding"],
  ["unbound staged record whose", "orphan cleanup"],
  ["never persist a raw HTTP body", "continuation cancel metadata-only persistence"],
  ["`SendMessageResponse` oneof wrapper", "A2A send response wrapper"],
  ["`GetTask`, and `CancelTask` MUST omit", "initial-send-only extension scope"],
  ["same exact `credentialBindingId` and", "successor binding invariant"],
  ["`callerGenerationId`", "successor caller generation invariant"],
  ["`predecessorRevisionId` and `intendedSuccessorRevisionId`", "successor journal lineage"],
  ["optional revision IDs are non-authoritative intent metadata", "revision metadata authority boundary"],
  ["final no-store resolve and winning `resolved` CAS must prove", "exact revision CAS proof"],
  ["the immutable lineage tuple is exactly", "immutable route lineage"],
  ["Mutable attempt `credentialRevisionId`", "mutable revision exclusion"],
  ["Encryption AAD is the versioned canonical encoding", "encryption AAD definition"],
  ["semantic hash covers the canonical method, exact immutable lineage tuple", "semantic lineage definition"],
  ["Only prompt-free `GetTask`", "credential revision carve-out"],
  ["`required: false`; LVIS route policy", "route-policy extension mandate"],
  ["That version header never activates an extension", "version and activation separation"],
  ["one CAS terminalizes live/in-progress fences as RETENTION_EXPIRED", "retention fence CAS"],
]) {
  requireText(normalizedP45, needle, label);
}

requireOrdered(
  normalizedP45,
  [
    "pass host authorization",
    "visible foreground `agent-action` approval",
    "durable preparation commits the prepared metadata-journal intent for every mutation",
    "for an initial Send only, the exact serialized body",
    "OS-safe local resolver",
    "final authenticated no-store route resolve",
    "CAS-attaches the complete snapshot ID",
    "data-plane socket starts immediately",
  ],
  "new-mutation security order",
);

for (const [needle, label] of [
  ["the exact serialized mutation body is placed in the OS-bound encrypted payload store", "universal mutation body store"],
  ["foreground approval -> encrypted payload plus prepared journal", "universal matrix body store"],
  ["rotates to another credential", "unqualified credential rotation ban"],
  ["never rotates credential", "legacy credential rotation wording"],
  ["exact credential tuple stays fixed", "legacy fixed credential tuple"],
  ["approved successor", "legacy approved-successor wording"],
  ["activates the extension on every operation", "unqualified per-operation activation"],
  ["extension activation on every operation", "unqualified per-operation activation"],
]) {
  rejectText(normalizedP45, needle, label);
}

requireOrdered(
  normalizedP45,
  [
    "non-sendable `staged`",
    "stage `prepared` referencing those exact fields",
    "changes the payload to `bound`",
    "secret preparation",
    "final no-store Hub resolve",
    "stage `resolved`",
    "socket may start",
  ],
  "payload-journal-route ordering",
);

for (const [needle, label] of [
  [extensionUri, "canonical URI"],
  ["RFC 2119 and", "requirements language"],
  ["`A2A-Extensions`", "request activation header"],
  ["every successful response", "response activation echo"],
  ["every `-32090` through `-32094`", "all error response echoes"],
  ["Only `-32092` carries `Retry-After`", "exclusive retry-after"],
  ["first non-streaming JSON-RPC `SendMessage`", "initial send applicability"],
  ["exact replay of that same initial send", "initial replay applicability"],
  ["MUST NOT send this profile's `A2A-Extensions`", "continuation other-method exclusion"],
  ["MUST send `A2A-Version: 1.0` on every A2A operation", "per-operation version header"],
  ["does not activate this extension", "version header activation boundary"],
  ["`required` MUST be the literal boolean `false`", "Agent Card required flag"],
  ["LVIS route policy, not the A2A", "route policy mandate"],
  ["Every new initial `SendMessage`, continuation `SendMessage`, and live", "all mutation preparation scope"],
  ["Only an initial Send MUST additionally retain", "initial-only body retention"],
  ["MUST NOT persist a raw/encrypted body or payload pointer", "metadata-only continuation cancel"],
  ["Staged/bound payload creation", "initial-only orphan cleanup"],
  ["The exhaustive prepared schema", "prepared schema exhaustiveness"],
  ["non-authoritative reconciliation intent only", "revision metadata authority boundary"],
  ["final no-store resolve and winning resolved CAS MUST prove", "exact revision CAS proof"],
  ["Prompt-free `GetTask` and an already-approved exact initial-Send replay", "credential revision carve-out"],
  ["Mutable attempt `credentialRevisionId`", "mutable revision exclusion"],
  ["same authenticated caller", "caller identity match"],
  ["byte-for-byte identical serialized HTTP body", "exact body match"],
  ["identical body SHA-256", "body hash match"],
  ["`SendMessageResponse` oneof wrapper", "durable send response wrapper"],
  ["`{ \"message\": Message }` or `{ \"task\": Task }`", "exact oneof branches"],
  ["place this oneof wrapper under `result`", "JSON-RPC success result wrapper"],
  ["exact request `id` value and type", "success request id fidelity"],
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
  ["Every custom error uses the complete JSON-RPC envelope", "error conformance vector"],
  ["atomically CAS any live or in-progress fence", "retention boundary CAS"],
  ["revoke its execution owner token", "retention owner revocation"],
  ["worker result arriving after that CAS", "late commit suppression"],
  ["Authentication and ordinary A2A authorization MUST complete", "auth ordering"],
  ["Required conformance vectors", "wire vectors"],
  [officialSpec, "official specification pin"],
]) {
  requireText(normalizedSpec, needle, label);
}
rejectText(spec, "byte-equivalent canonical", "canonical-body replay wording");
rejectText(spec, "`Message | Task` union result", "raw Message-or-Task union wording");
rejectText(spec, '"required": true', "legacy Agent Card required flag");
rejectText(spec, "extension on every A2A operation", "unqualified per-operation activation");

requireOrdered(
  normalizedSpec,
  [
    "first non-streaming JSON-RPC `SendMessage`",
    "exact replay of that same initial send",
    "MUST NOT send this profile's `A2A-Extensions`",
    "every successful response",
    "every `-32090` through `-32094` extension-error response",
  ],
  "extension applicability and echo scope",
);
requireExactSuccessContracts(spec);
requireExactErrorContracts(spec);
requireExactAgentExtensionContract(spec);

const linkCount = validateLocalLinks(blueprintPath, blueprint) + validateLocalLinks(specPath, spec);
if (linkCount < 2) fail(`expected at least two checked local links, got ${linkCount}`);

console.log(
  `[a2a-p4-5-contract] PASS blueprint_sha256=${sha256(blueprint)} spec_sha256=${sha256(spec)} local_links=${linkCount}`,
);
