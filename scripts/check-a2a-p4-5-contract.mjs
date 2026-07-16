import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const blueprintPath = resolve(root, "docs/blueprints/a2a-subagent-messaging.md");
const specPath = resolve(root, "docs/protocols/lvis-a2a-exact-send-replay.md");
const extensionUri = "https://lvis.ai/a2a/extensions/exact-send-replay/v1";
const officialSpec = "https://a2a-protocol.org/v1.0.0/specification/";
const exactProtocolBindingPhrase = "`JSONRPC` (JSON-RPC) binding";
const proseNameAsProtocolBinding = /`JSON-RPC`(?:\s+\(JSON-RPC\))?\s+binding/;
const fenceOpeningPattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const fenceClosingPattern = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const jsonFenceInfoPattern = /^[ \t]*json[ \t]*$/;
const expectedExtensionParams = {
  profile: "lvis-exact-send-replay",
  profileVersion: "1",
  requestBody: "exact-serialized-jsonrpc",
  resultRetentionSeconds: "604800",
  specDigestSha256: "<64 lowercase hexadecimal characters>",
};

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

function hasExactObjectEntries(actual, expected) {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function validateExactObjectEntryComparison() {
  const reorderedValid = {
    specDigestSha256: "<64 lowercase hexadecimal characters>",
    resultRetentionSeconds: "604800",
    requestBody: "exact-serialized-jsonrpc",
    profileVersion: "1",
    profile: "lvis-exact-send-replay",
  };
  const missing = {
    profile: "lvis-exact-send-replay",
    profileVersion: "1",
    requestBody: "exact-serialized-jsonrpc",
    resultRetentionSeconds: "604800",
  };
  const extra = { ...expectedExtensionParams, unexpected: "rejected" };
  const wrong = { ...expectedExtensionParams, profileVersion: "2" };
  if (!hasExactObjectEntries(reorderedValid, expectedExtensionParams)) {
    fail("exact-object self-test rejected reordered valid params");
  }
  for (const [label, candidate] of [
    ["missing", missing],
    ["extra", extra],
    ["wrong", wrong],
  ]) {
    if (hasExactObjectEntries(candidate, expectedExtensionParams)) {
      fail(`exact-object self-test accepted ${label} params`);
    }
  }
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function validateProtocolBindingFixture() {
  const fixtures = [
    {
      label: "exact wire token",
      text: `uses the ${exactProtocolBindingPhrase}`,
      exactCount: 1,
      rejectsProseToken: false,
    },
    {
      label: "prose name used as wire token",
      text: "uses the `JSON-RPC` binding",
      exactCount: 0,
      rejectsProseToken: true,
    },
  ];
  for (const fixture of fixtures) {
    if (countOccurrences(fixture.text, exactProtocolBindingPhrase) !== fixture.exactCount) {
      fail(`protocol-binding fixture count mismatch: ${fixture.label}`);
    }
    if (proseNameAsProtocolBinding.test(fixture.text) !== fixture.rejectsProseToken) {
      fail(`protocol-binding fixture classification mismatch: ${fixture.label}`);
    }
  }
}

function requireExactProtocolBinding(text, expectedCount, label) {
  const actualCount = countOccurrences(text, exactProtocolBindingPhrase);
  if (actualCount !== expectedCount) {
    fail(
      `${label}: expected ${expectedCount} exact ${JSON.stringify(exactProtocolBindingPhrase)} occurrence(s), found ${actualCount}`,
    );
  }
  if (proseNameAsProtocolBinding.test(text)) {
    fail(`${label}: backticked prose name JSON-RPC cannot be the protocolBinding token`);
  }
}

function parseJsonFences(text) {
  const parsed = [];
  let jsonBlockCount = 0;
  let openFence = null;

  for (const line of text.split(/\r\n|\n/)) {
    if (openFence === null) {
      const opening = line.match(fenceOpeningPattern);
      if (opening === null) continue;
      const marker = opening[1];
      const isJson = jsonFenceInfoPattern.test(opening[2]);
      if (isJson) jsonBlockCount += 1;
      openFence = {
        char: marker[0],
        length: marker.length,
        isJson,
        jsonIndex: isJson ? jsonBlockCount : null,
        lines: [],
      };
      continue;
    }

    const closing = line.match(fenceClosingPattern);
    const closesCurrent =
      closing !== null &&
      closing[1][0] === openFence.char &&
      closing[1].length >= openFence.length;
    if (closesCurrent) {
      if (openFence.isJson) {
        try {
          parsed.push(JSON.parse(openFence.lines.join("\n")));
        } catch (error) {
          fail(`spec JSON block ${openFence.jsonIndex} is invalid: ${error.message}`);
        }
      }
      openFence = null;
      continue;
    }

    if (openFence.isJson) openFence.lines.push(line);
  }

  if (openFence?.isJson) {
    fail(`spec JSON block ${openFence.jsonIndex} is invalid: unclosed JSON fence`);
  }
  // An unclosed non-JSON fence contributes no JSON block and is ignored.
  return parsed;
}

function expectJsonFenceParseFailure(text, expectedIndex, label, expectedDetail) {
  let caught;
  try {
    parseJsonFences(text);
  } catch (error) {
    caught = error;
  }
  const expectedPrefix = `[a2a-p4-5-contract] spec JSON block ${expectedIndex} is invalid:`;
  if (!(caught instanceof Error) || !caught.message.startsWith(expectedPrefix)) {
    fail(`${label}: expected parse failure with prefix ${JSON.stringify(expectedPrefix)}`);
  }
  if (expectedDetail !== undefined && !caught.message.endsWith(expectedDetail)) {
    fail(`${label}: expected parse failure ending ${JSON.stringify(expectedDetail)}`);
  }
}

function validateJsonFenceExtraction() {
  const lfFixture = [
    "prose before",
    "   ```json",
    '{"branch":"message"}',
    "   ````  ",
    "~~~ \tjson\t ",
    '{"branch":"task","count":2}',
    "~~~~~",
    "prose after",
  ].join("\n");
  const crlfFixture = lfFixture.replaceAll("\n", "\r\n");
  const expected = [
    { branch: "message" },
    { branch: "task", count: 2 },
  ];
  for (const [label, fixture] of [
    ["LF", lfFixture],
    ["CRLF", crlfFixture],
  ]) {
    const actual = parseJsonFences(fixture);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label} JSON-fence fixture extracted an unexpected value`);
    }
  }
  if (parseJsonFences("prose without a JSON fence").length !== 0) {
    fail("fence-free fixture produced a JSON block");
  }
  expectJsonFenceParseFailure("```json\r\n\r\n```", 1, "empty JSON fence");
  expectJsonFenceParseFailure(
    ["```json", "{}", "```", "```json", "{malformed", "```"].join("\n"),
    2,
    "malformed second JSON fence",
  );
  expectJsonFenceParseFailure(
    ["```json", "{}", "```", "~~~ json", "{}"].join("\n"),
    2,
    "unclosed JSON fence",
    "unclosed JSON fence",
  );

  for (const [label, fixture] of [
    ["inline fake fence", ["prefix ```json", '{"fake":true}', "```"].join("\n")],
    ["four-space-indented fake fence", ["    ```json", '{"fake":true}', "    ```"].join("\n")],
    [
      "nested triple fence",
      ["````text", "```json", '{"fake":true}', "```", "````"].join("\n"),
    ],
    [
      "unclosed non-JSON fence",
      ["~~~text", "```json", '{"fake":true}', "```"].join("\n"),
    ],
    ["non-lowercase info string", ["```JSON", "{}", "```"].join("\n")],
  ]) {
    if (parseJsonFences(fixture).length !== 0) {
      fail(`${label} fixture produced a JSON block`);
    }
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
  const jsonBlocks = parseJsonFences(text);
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
  const jsonBlocks = parseJsonFences(text);
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
  const jsonBlocks = parseJsonFences(text);
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
  if (!hasExactObjectEntries(declaration.params, expectedExtensionParams)) {
    fail("Agent Card extension declaration has unexpected params");
  }
}

const blueprint = readRequired(blueprintPath);
const spec = readRequired(specPath);
const p41Start = blueprint.indexOf("### Ph4 decomposition: P4-1 admission");
const p41End = blueprint.indexOf("#### P4-2 durable Agent Card registry contract", p41Start);
const p45Start = blueprint.indexOf("#### P4-5 / G005 direct remote-routing contract");
const p45End = blueprint.indexOf("## Cross-host implementation review", p45Start);
if (p41Start < 0 || p41End < 0) fail("cannot isolate the P4-1 blueprint section");
if (p45Start < 0 || p45End < 0) fail("cannot isolate the P4-5 blueprint section");
const p41 = blueprint.slice(p41Start, p41End);
const p45 = blueprint.slice(p45Start, p45End);
const normalizedP41 = p41.replace(/\s+/g, " ");
const normalizedP45 = p45.replace(/\s+/g, " ");
const normalizedSpec = spec.replace(/\s+/g, " ");
validateContainmentPortability();
validateExactObjectEntryComparison();
validateProtocolBindingFixture();
validateJsonFenceExtraction();
requireExactProtocolBinding(normalizedP41, 1, "P4-1 protocol binding");
requireExactProtocolBinding(normalizedP45, 2, "P4-5 protocol binding");

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
  [
    "mandatory bounded `intendedCredentialRevisionId` on every attempt",
    "mandatory intended credential revision",
  ],
  [
    "`predecessorCredentialRevisionId` only when a prior durable attempt exists",
    "optional predecessor credential revision",
  ],
  [
    "new mutation, `intendedCredentialRevisionId` is the exact revision named",
    "mutation approval revision source",
  ],
  ["exact fresh locally authorized revision intended", "prompt-free revision source"],
  [
    "Neither revision field grants route or credential authority",
    "revision route-authority boundary",
  ],
  ["authoritative intent constraint", "revision intent authority"],
  ["final no-store Hub resolve and winning `resolved` CAS must match", "exact revision CAS proof"],
  ["zeroizes the prepared secret", "revision mismatch secret zeroize"],
  ["deletes any unbound initial-Send staged payload", "revision mismatch staged cleanup"],
  ["terminalizes the attempt as `NOT_SENT`", "revision mismatch terminal state"],
  ["INTENDED_CREDENTIAL_REVISION_CONFLICT", "revision conflict outcome"],
  ["no case opens a duplicate socket", "revision conflict socket fence"],
  ["the immutable lineage tuple is exactly", "immutable route lineage"],
  ["Attempt `credentialRevisionId`", "attempt revision exclusion"],
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
  ["`predecessorRevisionId`", "legacy predecessor revision field"],
  ["`intendedSuccessorRevisionId`", "legacy intended successor field"],
  ["optional `intendedCredentialRevisionId`", "optional intended credential revision"],
]) {
  rejectText(normalizedP45, needle, label);
}

requireOrdered(
  normalizedP45,
  [
    "mandatory bounded `intendedCredentialRevisionId` on every attempt",
    "final no-store Hub resolve and winning `resolved` CAS must match",
    "zeroizes the prepared secret",
    "terminalizes the attempt as `NOT_SENT`",
    "zero socket I/O",
  ],
  "prepared intended-revision fence ordering",
);

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
  ["JSON object member order is not semantic", "params member-order independence"],
  ["LVIS route policy, not the A2A", "route policy mandate"],
  [
    "Every attempt—new initial `SendMessage`, continuation `SendMessage`, live",
    "all-attempt preparation scope",
  ],
  ["Only an initial Send MUST additionally retain", "initial-only body retention"],
  ["MUST NOT persist a raw/encrypted body or payload pointer", "metadata-only continuation cancel"],
  ["Staged/bound payload creation", "initial-only orphan cleanup"],
  ["The exhaustive prepared schema", "prepared schema exhaustiveness"],
  [
    "mandatory bounded `intendedCredentialRevisionId` on every attempt",
    "mandatory intended credential revision",
  ],
  [
    "`predecessorCredentialRevisionId` only when a prior durable attempt exists",
    "optional predecessor credential revision",
  ],
  ["exact revision named by foreground approval", "mutation approval revision source"],
  ["exact fresh locally authorized", "prompt-free revision source"],
  ["Neither field grants route or credential authority", "revision route-authority boundary"],
  ["authoritative intent constraint", "revision intent authority"],
  ["final no-store Hub resolve and winning resolved CAS MUST prove", "exact revision CAS proof"],
  ["zeroizes the prepared secret", "revision mismatch secret zeroize"],
  ["deletes any unbound initial-Send staged payload", "revision mismatch staged cleanup"],
  ["durably terminalizes the attempt as", "revision mismatch terminal state"],
  ["INTENDED_CREDENTIAL_REVISION_CONFLICT", "revision conflict outcome"],
  ["no duplicate socket", "revision conflict socket fence"],
  ["all five exact params in a different JSON member order is", "params order conformance vector"],
  ["extra key, missing key, or wrong value fails closed", "params negative conformance vector"],
  ["Prompt-free `GetTask` and an already-approved exact initial-Send replay", "credential revision carve-out"],
  ["Attempt `credentialRevisionId`", "attempt revision exclusion"],
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
rejectText(spec, "`predecessorRevisionId`", "legacy predecessor revision field");
rejectText(spec, "`intendedSuccessorRevisionId`", "legacy intended successor field");
rejectText(spec, "optional `intendedCredentialRevisionId`", "optional intended credential revision");

requireOrdered(
  normalizedSpec,
  [
    "mandatory bounded `intendedCredentialRevisionId` on every attempt",
    "final no-store Hub resolve and winning resolved CAS MUST prove",
    "zeroizes the prepared secret",
    "durably terminalizes the attempt as `NOT_SENT`",
    "starts no socket",
  ],
  "spec intended-revision fence ordering",
);

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
