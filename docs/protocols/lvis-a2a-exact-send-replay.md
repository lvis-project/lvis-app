# LVIS A2A Exact Send Replay Extension v1

- Canonical URI: `https://lvis.ai/a2a/extensions/exact-send-replay/v1`
- Protocol profile: A2A v1.0, JSON-RPC binding, non-streaming `SendMessage`
- Status: normative implementation contract; live activation is prohibited until
  this exact document is served at the canonical URI and its SHA-256 digest is
  pinned by both route policy and the packaged client

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and
**OPTIONAL** in this document are to be interpreted as described in RFC 2119 and
RFC 8174 when, and only when, they appear in all capitals.

## Purpose and scope

A2A v1.0 does not universally guarantee that retrying a `SendMessage` after the
request body was accepted but the response was lost will execute only once. This
extension defines the narrow server contract required by LVIS for an exact replay
of that ambiguous initial send. It does not make other A2A methods idempotent, add
streaming, authorize a caller, weaken Task ownership, or permit route substitution.

The extension applies exactly to the first non-streaming JSON-RPC `SendMessage`
of a new operation and an exact replay of that same initial send. A continuation
`SendMessage`, `GetTask`, `CancelTask`, streaming, push notification, or any other
method MUST NOT send this profile's `A2A-Extensions` header or extension metadata,
and the server MUST NOT echo or apply this profile to such a request. LVIS uses
its separate durable operation fencing for those methods.

The client MUST send `A2A-Version: 1.0` on every A2A operation, including
continuation `SendMessage`, `GetTask`, and `CancelTask`. That per-operation
version header does not activate this extension. Only the initial Send and an
exact replay of that same initial Send use the activation header and metadata
defined below.

## Declaration and bounded parameters

An eligible Agent Card MUST contain exactly one entry in
`capabilities.extensions` with this exact shape:

```json
{
  "uri": "https://lvis.ai/a2a/extensions/exact-send-replay/v1",
  "description": "Durable exact replay for ambiguous non-streaming SendMessage responses.",
  "required": false,
  "params": {
    "profile": "lvis-exact-send-replay",
    "profileVersion": "1",
    "requestBody": "exact-serialized-jsonrpc",
    "resultRetentionSeconds": "604800",
    "specDigestSha256": "<64 lowercase hexadecimal characters>"
  }
}
```

The entry MUST satisfy the bounded P4-1 `AgentExtension` parser. `params` MUST be
a strict object containing exactly the five string members above. Values MUST
byte-match the literals shown, except `specDigestSha256`, which MUST equal the
SHA-256 digest of the exact specification bytes served at the canonical URI.
JSON object member order is not semantic; exact key membership and values are.
`resultRetentionSeconds` is the decimal string for seven days and `required`
MUST be the literal boolean `false`. Unknown, missing,
duplicated, non-string, differently cased, or differently encoded fields make the
route ineligible. The extension URI, `required`, and `params` MUST participate in
the signed Agent Card payload and complete canonical-document hash.

`required: false` avoids claiming that every A2A operation on the interface must
activate this initial-Send-only profile. LVIS route policy, not the A2A
`AgentExtension.required` flag, nevertheless mandates the exact entry, exact
parameters, exact Agent Card digest, and exact served-specification digest before
an initial Send route is eligible. A route with `required: true` therefore fails
this LVIS profile just as a missing or malformed entry does.

Before enabling a live route, Agent Hub and the packaged LVIS client MUST fetch or
provision the canonical-URI document through their independently bounded trust
paths, verify identical exact bytes and SHA-256, and pin the digest. A route MUST
NOT become eligible merely because the URI string is declared or the interface is
reachable. Updating normative bytes requires a new extension URI.

## Activation

The client MUST send exactly one HTTP request header for the extension:

```http
A2A-Extensions: https://lvis.ai/a2a/extensions/exact-send-replay/v1
```

The value MUST contain this URI exactly once. The client MUST NOT activate any
other extension on the initial request or its exact replay. After activation has
been validated, the server MUST echo exactly the activated URI on every successful
response and on every `-32090` through `-32094` extension-error response:

```http
A2A-Extensions: https://lvis.ai/a2a/extensions/exact-send-replay/v1
```

The echo is REQUIRED by this profile even though the general A2A extension guide
uses a SHOULD. A missing, duplicated, malformed, or conflicting required echo
means the client cannot treat that initial-send response as extension-conformant.
Unsupported requested extensions MAY be ignored under the base protocol, but an
LVIS initial-send route MUST fail closed unless this extension is activated. The
echo rule does not widen applicability: continuation and other-method requests
MUST omit the profile and their responses MUST omit its echo.

The request `params.metadata` MUST contain one member whose key is the canonical
extension URI and whose value is exactly:

```json
{
  "intentSha256": "<64 lowercase hexadecimal characters>"
}
```

No other extension-owned metadata member is allowed. `intentSha256` is the
client's semantic hash over its approved owner; the exact immutable lineage tuple
(`targetAgentId`, canonical exact `interfaceUrl`, `agentCardDigestSha256`,
`trustKeyId`, `credentialBindingId`, `callerGenerationId`,
`routePolicyVersion`, `routePolicyDigestSha256`, and
`extensionSpecDigestSha256`); Task/context identity if present; Message identity;
configuration; and canonical DLP-processed payload. It excludes attempt
`credentialRevisionId`, mandatory `intendedCredentialRevisionId`, and optional
`predecessorCredentialRevisionId`, which are journaled separately and cannot
change the approved semantic intent. It is not a credential, authorization token,
or substitute for hashing the received body.

## LVIS host transaction binding

These client-side requirements bind use of this profile to the approved route;
they do not add fields to the A2A wire protocol.

- Every attempt—new initial `SendMessage`, continuation `SendMessage`, live
  `CancelTask`, prompt-free `GetTask`, or already-approved exact initial-Send
  replay—MUST commit prepared journal metadata before credential preparation,
  final no-store route resolve, resolved CAS, or socket I/O. Only an initial Send
  MUST additionally retain the byte-for-byte serialized body in the OS-bound
  encrypted payload store and journal its opaque pointer. Continuation and Cancel
  MUST retain bounded metadata plus semantic hash only and MUST NOT persist a
  raw/encrypted body or payload pointer. Staged/bound payload creation,
  failed-preparation deletion, and orphan cleanup are initial-Send-only paths.
- Initial-Send encryption AAD MUST be the versioned canonical encoding of the
  authenticated owner ID, operation ID, Message ID, exact body SHA-256, and exact
  immutable lineage tuple (`targetAgentId`, canonical exact `interfaceUrl`,
  `agentCardDigestSha256`, `trustKeyId`, `credentialBindingId`,
  `callerGenerationId`, `routePolicyVersion`, `routePolicyDigestSha256`, and
  `extensionSpecDigestSha256`). Attempt `credentialRevisionId`, mandatory
  `intendedCredentialRevisionId`, optional `predecessorCredentialRevisionId`,
  snapshot ID, and snapshot times MUST be excluded from both this AAD and
  immutable semantic lineage; revision intent is journaled separately.
- The exhaustive prepared schema is limited to host operation/attempt IDs;
  DLP-clean owner and operation kind; A2A method; the exact immutable lineage
  tuple; D8 depth; semantic-request hash; initial-Send-only ciphertext hash,
  opaque payload record ID, size, and expiry; Message ID; any known Task/context
  IDs; mutation approval decision ID/time; created/attempt deadlines; mandatory
  bounded `intendedCredentialRevisionId` on every attempt; and bounded optional
  `predecessorCredentialRevisionId` only when a prior durable attempt exists. A
  new mutation's intended ID is the exact revision named by foreground approval;
  prompt-free `GetTask` and exact replay use the exact fresh locally authorized
  intended revision. Neither field grants route or credential authority, but both
  are authoritative intent constraints. Final resolve and resolved CAS cannot
  substitute `intendedCredentialRevisionId`, and a present predecessor must match
  the prior durable attempt. Snapshot ID, resolved credential revision, resolve
  time, and snapshot issue/expiry times MUST be absent rather than null.
- Prompt-free `GetTask` and an already-approved exact initial-Send replay are the
  only attempts that MAY change `credentialRevisionId`, and only inside the exact
  same `credentialBindingId` and `callerGenerationId`; every other immutable
  field remains exact. Every new mutation requires foreground approval. The final
  no-store Hub resolve and winning resolved CAS MUST prove the same immutable
  lineage and exact mandatory `intendedCredentialRevisionId`; when present,
  `predecessorCredentialRevisionId` MUST equal the prior durable attempt. A
  missing or mismatched intended ID zeroizes the prepared secret, deletes any
  unbound initial-Send staged payload, durably terminalizes the attempt as
  `NOT_SENT`, and starts no socket.
- Credential intent remains independently fenced although revision fields are
  excluded from semantic hash and AAD. Approval/prepared revision A followed by
  an active same-binding Hub resolution for revision B MUST reject B as a
  substitute and take the `NOT_SENT` path above. Concurrent attempts with the
  same operation ID and byte-for-byte body but different
  `intendedCredentialRevisionId` values conflict rather than coalesce. At most the
  candidate whose intended ID exactly matches final resolve may win; every other
  candidate receives deterministic `INTENDED_CREDENTIAL_REVISION_CONFLICT` and
  `NOT_SENT`, with no duplicate socket.

## Replay key and exact-match rule

After authenticating and authorizing the request, the server MUST derive a stable
caller identity that survives credential rotation without exposing the credential.
That identity includes an immutable caller-generation token. Credential rotation
within one generation preserves the token. Permanently retiring a caller identity
retires that generation forever; if the same external subject later enrolls again,
the server MUST mint a new generation token, so its replay keys cannot collide with
the retired generation.
The replay key is:

```text
(authenticated caller identity, params.message.messageId)
```

For the first accepted key, before executing the Message, the server MUST durably
store an in-progress fence containing:

- the replay key;
- SHA-256 of the exact received serialized JSON-RPC HTTP body bytes;
- the exact `intentSha256` value;
- a bounded creation time and retention deadline; and
- an execution fence/owner token.

The body hash covers every received body byte, including JSON member order,
whitespace, and escaping. It excludes HTTP headers and credentials. The server
MUST NOT parse and reserialize a request to obtain this hash.

An exact replay is valid only when the same authenticated caller supplies the
same `messageId`, byte-for-byte identical serialized HTTP body, identical body
SHA-256, and identical `intentSha256`, and the LVIS client preserves the exact
immutable lineage tuple with only the same-binding/generation
`credentialRevisionId` carve-out above. It MUST join the existing in-progress
owner or return the stored completed result. It MUST NOT execute the Message
again, mint a new Message or Task identity, change context, or select another
route.

Reuse of the replay key with any mismatch MUST execute nothing and return the
fixed JSON-RPC error:

```json
{
  "jsonrpc": "2.0",
  "id": "<exact request id>",
  "error": {
    "code": -32090,
    "message": "Exact send replay conflict",
    "data": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "EXACT_SEND_REPLAY_CONFLICT",
        "domain": "lvis.ai"
      }
    ]
  }
}
```

The response `id` MUST preserve the exact request JSON-RPC ID value and type; the
string above is only a schema marker. The response MUST carry the activated
`A2A-Extensions` echo. Error data MUST NOT
reveal which field, byte, hash, credential, caller, or stored result differed.

Every extension error in this document is a complete JSON-RPC 2.0 response with
the exact request ID and an `error` member containing exactly one A2A v1 data-array
entry of `type.googleapis.com/google.rpc.ErrorInfo`. Codes, messages, reasons,
domains, metadata, and retry headers are exact wire values; a server MUST NOT add
a second data entry, substitute an object for the array, or place error fields at
the response root. Every `-32090` through `-32094` response carries the activated
`A2A-Extensions` echo. Only `-32092` carries `Retry-After`; the other four MUST NOT.

If the authenticated caller generation has reached its configured replay-key
capacity, the server MUST NOT evict or reuse an existing fence. It MUST accept no
new key, execute nothing, and return:

```json
{
  "jsonrpc": "2.0",
  "id": "<exact request id>",
  "error": {
    "code": -32094,
    "message": "Exact send replay capacity exhausted",
    "data": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "EXACT_SEND_REPLAY_CAPACITY_EXHAUSTED",
        "domain": "lvis.ai"
      }
    ]
  }
}
```

The client maps `-32090` to a non-retryable local conflict and `-32094` to
`capacity-manual-intervention-required`. Neither result permits an automatic
send, a new Message ID, route substitution, or eviction. An administrator may
raise the generation's capacity, but a client MUST still start a separately
approved new operation rather than retry this failed initial send automatically.

## Durable result and restart behavior

Before returning the first successful response, the server MUST durably replace
the in-progress fence with the complete original A2A v1 `SendMessageResponse`
oneof wrapper and its identity fields. The stored value is exactly one of
`{ "message": Message }` or `{ "task": Task }`; it is never a raw `Message`, a
raw `Task`, both branches, or an unwrapped `Message | Task` union. The JSON-RPC
success envelope MUST preserve `jsonrpc: "2.0"`, the exact request `id` value and
type, and place this oneof wrapper under `result`. A replay after either client or
server restart MUST return the same wrapper branch and durable identity: the same
`result.message.messageId`, or the same `result.task.id` and
`result.task.contextId`. It MUST NOT re-execute the Message. The stored original
wrapper is authoritative even if the Task later advances; current Task state is
obtained separately with `GetTask`.

The two permitted success-envelope shapes are:

```json
{
  "jsonrpc": "2.0",
  "id": "<exact request id>",
  "result": {
    "message": {
      "messageId": "<original message id>",
      "role": "ROLE_AGENT",
      "parts": [{"text": "<response>"}]
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": "<exact request id>",
  "result": {
    "task": {
      "id": "<original task id>",
      "contextId": "<original context id>",
      "status": {"state": "TASK_STATE_SUBMITTED"}
    }
  }
}
```

Placeholder strings stand for the complete original A2A values; they do not
authorize truncation. No success envelope may contain an `error` member.

Concurrent exact requests MUST elect one execution owner. Losing owners MUST wait
within a bounded deadline or return a fixed retryable in-progress error without
executing:

```json
{
  "jsonrpc": "2.0",
  "id": "<exact request id>",
  "error": {
    "code": -32092,
    "message": "Exact send replay in progress",
    "data": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "EXACT_SEND_REPLAY_IN_PROGRESS",
        "domain": "lvis.ai",
        "metadata": {"retryAfterSeconds": "1"}
      }
    ]
  }
}
```

The `-32092` response MUST also carry the HTTP header `Retry-After: 1`. The client
maps it to `reconciling` and MAY retry only the same authenticated caller,
byte-for-byte body, Message ID, intent hash, and exact immutable lineage tuple,
subject only to the credential-revision carve-out above, after at least one
second and within the original bounded reconciliation deadline. Such a retry is
an attempt of the already-approved operation: it requires fresh local
authorization, credential
preparation, and final no-store route resolve, but no new foreground approval. It
MUST NOT reconstruct the body, select another route, or extend the deadline.

A crash after the durable in-progress fence but before a result MUST be recovered
only by a worker that acquires the same durable execution fence and can prove that
the prior owner performed no uncommitted external execution. A late owner may
commit a result only while its owner token still matches. The server MUST NOT allow
an unfenced second execution. If it cannot prove single execution, it MUST retain
the fence, execute nothing, omit `Retry-After`, and return:

```json
{
  "jsonrpc": "2.0",
  "id": "<exact request id>",
  "error": {
    "code": -32093,
    "message": "Exact send replay outcome unknown",
    "data": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "EXACT_SEND_REPLAY_OUTCOME_UNKNOWN",
        "domain": "lvis.ai"
      }
    ]
  }
}
```

The client maps `-32093` to terminal local
`unknown-manual-reconciliation-required`, performs no automatic resend, and
fabricates no remote Message, Task, or terminal Task state.

The server MUST retain the complete fence and completed result for 604800 seconds
from the first accepted request. At the boundary one transaction MUST atomically
CAS any live or in-progress fence to terminal `RETENTION_EXPIRED`, revoke its
execution owner token, delete any exact body and `SendMessageResponse` result, and
write the durable non-sensitive tombstone. A worker result arriving after that CAS
MUST fail its owner-token/terminal-state CAS and be suppressed; it can neither
restore the result nor change the terminal fence. The tombstone contains only the
generation-scoped opaque caller token, opaque Message-ID token,
body hash, intent hash, first-accepted time, expiry time, and terminal fence state.
The tombstone remains until that caller generation is permanently retired. It is
never evicted to admit a new key, and its deletion after permanent retirement is
fenced and auditable. Reuse of an exact-match replay key at or after result expiry
MUST NOT execute and MUST return:

```json
{
  "jsonrpc": "2.0",
  "id": "<exact request id>",
  "error": {
    "code": -32091,
    "message": "Exact send replay retention expired",
    "data": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "EXACT_SEND_REPLAY_RETENTION_EXPIRED",
        "domain": "lvis.ai"
      }
    ]
  }
}
```

Any mismatch against the tombstone still returns `-32090`. The client maps
`-32091` to manual reconciliation and never reconstructs or resends a new body
under the expired Message ID. Because the A2A Message-ID namespace has no bounded
lifetime, a shorter tombstone TTL or least-recently-used eviction is prohibited.

## Authentication, authorization, and audit

Authentication and ordinary A2A authorization MUST complete before replay-store
existence or mismatch is disclosed. An inaccessible caller receives the same
binding-specific authentication or authorization response it would receive for a
new request. Bearer bytes, headers, raw body, Parts, Task status text, artifacts,
and response bodies MUST NOT be stored in the replay audit stream.

The replay store MAY retain the exact request body only when independently
encrypted and bounded by the same result-retention deadline; LVIS servers SHOULD
retain only the body hash, intent hash, fence metadata, and durable result required
by this contract. After result expiry, only the non-sensitive tombstone above may
remain. Logs, metrics, traces, crash reports, and audit MUST use fixed outcome
codes plus keyed opaque caller/Message/result tokens. Credential rotation MUST
preserve the authenticated caller generation; credential revocation MUST block
new requests before replay-store access and MUST NOT authorize a stale credential
solely to retrieve a result.

The extension does not replace TLS, bearer authentication, Agent Card signature
verification, foreground approval, Agent Hub route eligibility, per-operation
no-store resolve, D8 depth enforcement, or the host's encrypted recovery payload.
No extension field can widen a network, size, deadline, history, or retention
bound.

## Required conformance vectors

A pinned-head wire suite MUST record the packaged-client commit, Agent Hub commit,
remote-server commit, exact A2A v1.0 TCK release and full commit, this specification
SHA-256, Agent Card hash, and test artifact SHA-256. It MUST prove all of the
following with zero skipped cases:

1. First send returns JSON-RPC `result: { message: Message }`; exact replay before
   and after server restart returns the same oneof branch and
   `result.message.messageId`, with one execution and no raw-Message result.
2. First send returns JSON-RPC `result: { task: Task }`; exact replay before and
   after client and server restart returns the same oneof branch,
   `result.task.id`, and `result.task.contextId`, with one execution and neither a
   raw-Task result nor both branches.
3. The response is dropped only after the byte-for-byte serialized HTTP body and
   durable oneof wrapper commit; the client's stored exact bytes replay to the
   same JSON-RPC `result` wrapper and exact request ID value/type.
4. Two concurrent exact sends elect one owner and return one durable result.
5. Same caller and Message ID with one changed body byte, changed escaping,
   changed member order, or changed `intentSha256` returns `-32090` and executes
   nothing further.
6. A different authenticated caller cannot observe or reuse another caller's
   replay entry.
7. Missing declaration, wrong URI, `required: true`, malformed params,
   wrong served-spec digest, missing request activation, or missing required echo
   on an activated success/error fails closed. Continuation `SendMessage`,
   `GetTask`, and `CancelTask` send `A2A-Version: 1.0` but no profile
   header/metadata and receive no echo. The suite proves LVIS route policy rejects
   a missing profile despite its Agent Card `required: false` declaration. A
   declaration with all five exact params in a different JSON member order is
   valid; an extra key, missing key, or wrong value fails closed.
8. Retention-boundary replay succeeds immediately before expiry; at expiry one
   CAS changes even a live/in-progress fence to `RETENTION_EXPIRED`, revokes its
   owner token, deletes body/result, writes the tombstone, and suppresses a late
   owner commit. Exact reuse returns `-32091`, mismatch returns `-32090`, and both
   remain deterministic after restart without execution or tombstone eviction.
9. A live owner returns the full `-32092` JSON-RPC error envelope with exact
   request ID, required extension echo, exact data array, and `Retry-After: 1`;
   a bounded same-byte retry joins that owner and never extends its deadline.
10. Crash at every fence/result transaction boundary proves restart recovery,
    late-owner suppression, and no second execution. Every boundary whose single
    execution cannot be proved returns `-32093` with no retry header or execution.
11. A one-entry quota accepts no new replay key and returns `-32094` after the
    first tombstone exists; raising capacity admits only a separately approved new
    operation, and no test evicts or reuses the first key.
12. Credential rotation preserves the caller generation and replay key; permanent
    retirement followed by re-enrollment mints a new generation whose same
    external subject and Message ID cannot collide with the retired key.
13. Every custom error uses the complete JSON-RPC envelope, exact request ID,
    `error` member, numeric code, message, one-element A2A v1 `data` array,
    `google.rpc.ErrorInfo` type, reason, domain, metadata, required extension echo,
    and client mapping defined above. Only `-32092` carries `Retry-After`.
14. Prompt-free `GetTask` and an already-approved exact initial-Send replay may
    change only `credentialRevisionId` inside the exact same
    `credentialBindingId` and `callerGenerationId`; vectors change each other
    immutable-lineage field in turn and prove fail-closed behavior. New mutation
    vectors prove that even an in-binding revision change requires foreground
    approval. Every prepared attempt has mandatory
    `intendedCredentialRevisionId`; a new mutation takes it from approval and a
    prompt-free attempt from fresh local authorization. Optional
    `predecessorCredentialRevisionId` exists only with a prior durable attempt.
    Neither field grants route authority, but both are authoritative intent
    constraints: final resolve and resolved CAS MUST satisfy the exact intended
    ID, and a present predecessor must match the prior durable attempt.
15. Approval/prepared revision A with an active same-binding Hub resolution for B
    zeroizes the secret, deletes any unbound initial staged payload, records
    `NOT_SENT`, and opens no socket. Concurrent attempts with the same operation
    and body but different intended IDs produce at most one exact-match winner;
    every other attempt deterministically conflicts/records `NOT_SENT`, and no
    duplicate socket is observed.
16. Logs, audit, metrics, traces, Hub storage, and packet-path assertions contain
    no bearer, secret reference, prompt Part, artifact, or raw replay body.

Interface health may establish only bounded declaration and reachability. It MUST
NOT be used as evidence that any conformance vector passed.

## Normative references

- [A2A v1.0 specification](https://a2a-protocol.org/v1.0.0/specification/)
- [A2A extension guide](https://a2a-protocol.org/latest/topics/extensions/)
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)
- [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)
