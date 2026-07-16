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

The extension applies only to non-streaming JSON-RPC `SendMessage`. `GetTask`,
`CancelTask`, continuation Messages, streaming, push notifications, and other
bindings are outside this extension. LVIS implements its own durable operation
fencing for those methods.

## Declaration and bounded parameters

An eligible Agent Card MUST contain exactly one entry in
`capabilities.extensions` with this exact shape:

```json
{
  "uri": "https://lvis.ai/a2a/extensions/exact-send-replay/v1",
  "description": "Durable exact replay for ambiguous non-streaming SendMessage responses.",
  "required": true,
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
`resultRetentionSeconds` is the decimal string for seven days. Unknown, missing,
duplicated, non-string, differently cased, or differently encoded fields make the
route ineligible. The extension URI, `required`, and `params` MUST participate in
the signed Agent Card payload and complete canonical-document hash.

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
other extension on the request. The server MUST echo exactly the activated URI in
the successful response:

```http
A2A-Extensions: https://lvis.ai/a2a/extensions/exact-send-replay/v1
```

The echo is REQUIRED by this profile even though the general A2A extension guide
uses a SHOULD. A missing, duplicated, malformed, or conflicting response echo
means the client cannot treat the response as extension-conformant. Unsupported
requested extensions MAY be ignored under the base protocol, but an LVIS route
MUST fail closed unless this extension is activated.

The request `params.metadata` MUST contain one member whose key is the canonical
extension URI and whose value is exactly:

```json
{
  "intentSha256": "<64 lowercase hexadecimal characters>"
}
```

No other extension-owned metadata member is allowed. `intentSha256` is the
client's semantic hash over its approved owner, pinned target/interface lineage,
Task/context identity if present, Message identity, configuration, and canonical
DLP-processed payload. It is not a credential, authorization token, or substitute
for hashing the received body.

## Replay key and exact-match rule

After authenticating and authorizing the request, the server MUST derive a stable
caller identity that survives credential rotation without exposing the credential.
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
same `messageId`, byte-for-byte identical serialized body, identical body SHA-256,
and identical `intentSha256`. It MUST join the existing in-progress owner or
return the stored completed result. It MUST NOT execute the Message again, mint a
new Message or Task identity, change context, or select another route.

Reuse of the replay key with any mismatch MUST execute nothing and return the
fixed JSON-RPC error:

```json
{
  "code": -32090,
  "message": "Exact send replay conflict",
  "data": {"reason": "exact-send-replay-conflict"}
}
```

The response MUST carry the activated `A2A-Extensions` echo. Error data MUST NOT
reveal which field, byte, hash, credential, caller, or stored result differed.

## Durable result and restart behavior

Before returning the first successful response, the server MUST durably replace
the in-progress fence with the complete original A2A `Message | Task` union result
and its identity fields. A replay after either client or server restart MUST
return the same union kind and durable identity: the same direct
`Message.messageId`, or the same `Task.id` and `Task.contextId`. It MUST NOT
re-execute the Message. The stored original result is authoritative even if the
Task later advances; current Task state is obtained separately with `GetTask`.

Concurrent exact requests MUST elect one execution owner. Losing owners MUST wait
within a bounded deadline or return a fixed retryable in-progress error without
executing. A crash after the durable in-progress fence but before a result MUST be
recovered by a fenced server worker; it MUST NOT allow an unfenced second
execution. If the implementation cannot prove a single execution, it MUST retain
the fence and return an outcome-unknown error rather than execute again.

The server MUST retain the fence and completed result for 604800 seconds from the
first accepted request. Deletion MUST be fenced and auditable. After retention
expiry, reuse of the replay key MUST NOT execute and MUST return:

```json
{
  "code": -32091,
  "message": "Exact send replay retention expired",
  "data": {"reason": "exact-send-replay-retention-expired"}
}
```

The client maps this to manual reconciliation and never reconstructs or resends a
new body under the expired Message ID.

## Authentication, authorization, and audit

Authentication and ordinary A2A authorization MUST complete before replay-store
existence or mismatch is disclosed. An inaccessible caller receives the same
binding-specific authentication or authorization response it would receive for a
new request. Bearer bytes, headers, raw body, Parts, Task status text, artifacts,
and response bodies MUST NOT be stored in the replay audit stream.

The replay store MAY retain the exact request body only when independently
encrypted and bounded by the same retention deadline; LVIS servers SHOULD retain
only the body hash, intent hash, fence metadata, and durable result required by
this contract. Logs, metrics, traces, crash reports, and audit MUST use fixed
outcome codes plus keyed opaque caller/Message/result tokens. Credential rotation
MUST preserve the authenticated caller identity; credential revocation MUST block
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

1. First send returns a direct Message; exact replay before and after server
   restart returns the same union kind and `Message.messageId`, with one execution.
2. First send returns a Task; exact replay before and after client and server
   restart returns the same original `Task.id` and `Task.contextId`, with one
   execution.
3. The response is dropped only after the body and durable result commit; the
   client's stored exact bytes replay to the same result.
4. Two concurrent exact sends elect one owner and return one durable result.
5. Same caller and Message ID with one changed body byte, changed escaping,
   changed member order, or changed `intentSha256` returns `-32090` and executes
   nothing further.
6. A different authenticated caller cannot observe or reuse another caller's
   replay entry.
7. Missing declaration, wrong URI, `required: false`, malformed or extra params,
   wrong served-spec digest, missing request activation, or missing response echo
   fails closed.
8. Retention-boundary replay succeeds immediately before expiry and returns
   `-32091` at or after expiry without execution.
9. Crash at every fence/result transaction boundary proves restart recovery,
   late-owner suppression, and no second execution.
10. Logs, audit, metrics, traces, Hub storage, and packet-path assertions contain
    no bearer, secret reference, prompt Part, artifact, or raw replay body.

Interface health may establish only bounded declaration and reachability. It MUST
NOT be used as evidence that any conformance vector passed.

## Normative references

- [A2A v1.0 specification](https://a2a-protocol.org/v1.0.0/specification/)
- [A2A extension guide](https://a2a-protocol.org/latest/topics/extensions/)
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)
- [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)
