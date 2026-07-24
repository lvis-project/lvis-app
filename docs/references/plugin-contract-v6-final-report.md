# Plugin Contract v6 — Final Consistency Report (#885 initial design vs achieved)

Status: Final report, written 2026-07-10 after host 0.5.1 + the 0.5.2 host-side contract-reduction wave. Korean summary at the end (한국어 요약).

> 2026-07-23 amendment: composite domain tools add the signed, Tool-local
> `_meta["lvisai/operationPolicy"]` restriction key. The single `Tool[]` and
> manifest==wire decisions remain unchanged; no top-level action/policy map exists.

This document answers one question, asked when the legacy-reader removal (R) was commissioned: **compared to the initial #885 design, how consistent is the achieved state — was the tool schema correctly unified?**

## 1. The initial design (#885, as redefined 2026-05-17)

#885's primary goal, after the Claude Code / Codex CLI reference check ruled out a full MCP JSON-RPC migration, was two-fold:

- **(a) Plugin manifest contract simplification** — unify the split `tools[]` (name strings) + separate `toolSchemas[]` map into **colocated tool objects** borrowing the MCP `tools/list` shape; consolidate the scattered SoTs (`capabilities[]` / `permissions` / `pathFields` / `category`); position the SDK as an *optional helper*, not a required dependency.
- **(b) MCP server isolation parity** — plugin UI surfaces and external MCP App surfaces get equivalent isolation (per-server partitions, teardown, one governed executor pipeline).

Out of scope by design: forcing the plugin contract into MCP JSON-RPC wholesale, and external MCP clients invoking LVIS plugin tools.

## 2. The achieved contract (host 0.5.0 → 0.5.1 → 0.5.2 wave)

### 2.1 Tool schema — unified, pure MCP shape ✅

`PluginManifest.tools` is a single colocated array of **pure MCP `Tool` objects** — `{ name, title?, description?, inputSchema, outputSchema?, icons?, _meta? }` (`src/plugins/public-contract.ts`). **Manifest == wire**: the same object the manifest declares is what the loopback MCP `tools/list` serves. The legacy triple (`tools[]` strings + `toolSchemas` map + `uiActions` map) is gone from the host in both directions:

| Legacy element | Replacement | Where enforced |
|---|---|---|
| `tools: string[]` + `toolSchemas[]` | colocated pure `Tool[]` | AJV (SDK schema) + fail-closed pre-v6 reject with upgrade message (`manifest-validation.ts`) |
| `uiActions[]` map | per-tool `_meta.ui.visibility: ["model"\|"app"]` (SEP-1865) | `normalizeManifest` materializes the dual default; empty visibility throws |
| `toolSchemas[*].pathFields` | `_meta["lvisai/pathFields"]` | permission pipeline reads only this |
| composite operation restrictions (2026-07-23) | `_meta["lvisai/operationPolicy"]` on the same Tool | validated against `inputSchema.operation`; can only raise risk, narrow app visibility, or require a prior read |
| per-tool manifest `category` | **removed everywhere** — host classifies risk per invocation (`inspectHostRisk`); 0.5.2 #1582 completed the removal for the out-of-process stdio path (wire-declared category is now ignored; it had been shadow-only under `hostClassifiesRisk` anyway) | executor + risk classification |
| `writesToOwnSandbox`, `version`, `deprecatedSince`, `replacedBy` per-tool fields | removed from the Tool contract (Phase R) | schema `additionalProperties:false` |

The compat layer itself is gone: `normalizeManifest` is a pure-form visibility **materializer**, not a legacy compiler (0.5.1, PR #1572). A pre-v6 manifest fails loudly at load with an actionable "upgrade to `@lvis/plugin-sdk` v6" error naming the offending tool index. **Plugin Doctor** (0.5.1, #1573) replaced the originally planned 0.6.0 time-gate: a legacy install that fails the pure reader is diagnosed and auto-reinstalled at its latest v6 version — which is why the removal could ship early without a broken-plugin window.

### 2.2 Host-derived governance ✅ (stronger than the initial design)

The initial design asked for SoT consolidation; effective authority remains Host-owned. The signed
operation-policy amendment is restriction-only and cannot lower a Host verdict:

- Effective per-tool risk category: host-computed per invocation, never declared (see table above).
- Tool ownership / `writesToOwnSandbox` / model-vs-app routing: host-derived from the manifest's model-visible tools (0.5.0 #1564).
- Capability gates: routed through typed SoT constants (`capabilities.ts`) at every gate site including the marketplace TOCTOU cross-check (0.5.2 #1580).
- `${id}.auth.changed`: host-derives and bridges it whenever `auth` is declared — the author no longer re-declares the fixed string in `emittedEvents[]` (0.5.2 #1581, literal-id contract preserved).

### 2.3 Duplicate projections — removed ✅ (0.5.2 extension of the goal)

The marketplace catalog's parallel `tools: string[]` projection and its manifest-mirroring fields (`defaultConfig`/`ui`/`keywords`/`emittedEvents`/`notificationEvents`) were provably dead (wrong-key read, unreachable consumer) and were removed; the manifest-synthesizing `buildInstalledManifest` fallback became a hard error (0.5.2 #1578). What remains on the catalog item is deliberately *not* redundant: pre-install display fields and the trusted "expected" side of the install-integrity cross-check (`installPolicy`/`pluginAccess`/`networkAccess`/`dependencies`/`requires`/`capabilities`).

### 2.4 Isolation parity (b) ✅

Shipped in 0.5.0: per-server MCP partitions with injective fail-closed encoding + teardown sweeps (#1565); external MCP tools and in-process plugin loopback tools traverse the **one** `ToolExecutor` pipeline and converge at the same governed chokepoints, with low-trust foreign MCP peers categorically excluded from reviewer auto-approve (#1566).

### 2.5 First-party migration ✅

All 7 first-party plugins are pure v6 (verified 2026-07-10): git 0.1.9 (24 tools), ep 0.17.27 (29), local-indexer 0.5.20 (13), meeting 0.5.30 (32), ms-graph 0.3.39 (30), work-assistant 0.10.7 (3), template 0.1.3 (0 tools). None carries `toolSchemas`/`uiActions`/`ui[].kind:"action"`; all pre-validate clean against the collapsed schema.

## 3. Honest divergences from the initial design

1. **The compat window collapsed to ~zero.** (a2) planned a legacy-reading window until a 0.6.0 removal. In practice the reader shipped in 0.5.0 and was deleted in 0.5.1 — because Plugin Doctor made the time-gate unnecessary. The end state is **purer** than the phased plan, reached faster.
2. **"SDK as optional helper" is achieved for authority.** Authors may use the SDK package for compile-time types and the pinned publish schema, but the Host imports neither at runtime. The complete public TypeScript contract and JSDoc live in `src/plugins/public-contract.ts`; the manifest schema lives in `schemas/plugin-manifest.schema.json`. The SDK mechanically mirrors both and owns no declaration-selection or documentation policy.
3. **The authoring schema lag was closed.** The Host-owned schema now matches the pure reader and rejects legacy `tools` strings, `toolSchemas`, `uiActions`, `ui[].kind:"action"`, and parallel operation/action policy fields. The SDK schema is a verbatim generated mirror for plugin and marketplace CI pinned to an SDK tag.
4. **Two stale catalog entries remain** (hello-world 0.1.1, git 0.1.8 — both legacy shape, both already unloadable on ≥0.5.0). Republish of git 0.1.9 + a pure hello-world reseed closes this; scheduled with the SDK-bump wave.

## 4. Verdict

**The tool schema remains correctly unified.** One shape (pure MCP `Tool`), declared once, served as-is over the wire, and validated by one canonical schema. The two LVIS keys are path restrictions and signed composite-operation restrictions; neither can lower Host-derived risk. The operation amendment remains inside the Tool and introduces no parallel map.

---

## 한국어 요약

**질문: 초기 #885 설계 대비, 툴 스키마가 올바르게 통일되었는가? → 예.**

- 매니페스트 `tools`는 **pure MCP `Tool` 객체 단일 배열**(manifest == wire). 레거시 삼중(`tools[]` 문자열 + `toolSchemas` + `uiActions`)은 코드·문서·에러 문구까지 완전 제거.
- 표면 노출은 툴별 `_meta.ui.visibility`(SEP-1865). LVIS 전용 키는 path 제한과
  2026-07-23에 추가된 Tool-local operation 제한 두 개이며, 별도 action/policy 맵은 없음.
- per-tool `category` 등 플러그인 자기선언 거버넌스 신호는 전부 제거 — 호스트가 invocation별 산출(`inspectHostRisk`). 0.5.2에서 stdio 경로 잔재까지 완결.
- 레거시 호환 리더는 0.5.1에서 삭제(Plugin Doctor가 타이밍게이트 대체) — 초기 계획(0.6.0 대기)보다 **더 순수한 상태를 더 빨리** 달성.
- 마켓플레이스의 중복 `tools[]` 프로젝션·미러 필드 제거(0.5.2). 유지된 카탈로그 필드는 사전-설치 표시와 설치 무결성 교차검증 앵커뿐.
- 미완(진행 중): SDK 스키마의 레거시 arm 붕괴(집필 시점 in-flight) + git 0.1.9/hello-world 재게시. 스키마 소유권(SDK vs host)은 보류된 Option A ph2 결정으로 존중.
