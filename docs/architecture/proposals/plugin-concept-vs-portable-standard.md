# LVIS "plugin" vs the portable Agent Plugins packaging standard — concept + naming proposal

> Status: **Proposal** (owner directive 2026-08-16: the standard is NOT being adopted now;
> the prerequisite is putting OUR OWN plugin model in order — clear naming, clear
> separation — so that adoption stays possible later without a collision.)

## 1. The collision

Agent Plugins `1.0.0` (agent-plugins.org, published 2026-08-06; Working Draft) is a
vendor-neutral **directory packaging format** for agent extensions. Its manifest is a
root-level **`plugin.json` with a closed schema** — exactly ten allowed top-level keys,
anything else invalid — plus optional `skills/<name>/SKILL.md`, an `mcp.json` server
declaration, and reverse-domain client-extension directories.

LVIS also calls its unit a **plugin**, with a root **`plugin.json`** — but the two
concepts only partially overlap:

| Axis | Agent Plugins standard | LVIS plugin |
|---|---|---|
| Unit | Portable directory of loosely-coupled components (skills, MCP servers) | Signed-zip artifact: manifest + entry/factory code + tools + optional MCP-App `ui://` cards |
| Manifest | `plugin.json`, closed schema (10 keys), `extensions` for everything else | `plugin.json`, LVIS-proprietary schema (tools, `_meta["lvisai/*"]`, uiResources, pluginAccess, …) |
| Trust | Explicitly out of scope (no signing, no registry, no permissions) | The core: signed artifacts, install receipts, marketplace approval, category-gated execution |
| Runtime relation | Host mounts components; failure isolation per component | Plugin IS an MCP server behind the host's per-plugin client (loopback/stdio) |

Same file name + closed schema means the two manifests are **mutually unintelligible**:
a conformant standard host reads our `plugin.json` and must reject it; our loader reads
a standard `plugin.json` and finds no tools. That is a name collision, not a
compatibility path.

## 2. What the owner directed

Not adoption. First, make the LVIS side unambiguous — rename or separate — so the
concepts stop sharing one word and one filename by accident. Track the standard
(Draft, key ecosystem participants still absent) without coupling to it.

## 3. Proposal

### 3.1 Name the LVIS concept precisely (docs + UI vocabulary)

Reserve the bare word "plugin" for the generic idea. In docs and user-facing surfaces,
the LVIS unit becomes the **"LVIS package"** (working name — final pick is an owner
call; candidates: package / applet / extension). The renaming is vocabulary-first:
identifiers and IPC channels do NOT churn now (that is a separate, mechanical wave
if ever justified).

### 3.2 Separate the manifest identity (the real fix)

Rename the LVIS manifest file `plugin.json` → **`lvis-plugin.json`** (schema field
`$schema` pointing at our own versioned schema URL). Effects:

- The collision disappears structurally: a directory can carry BOTH manifests —
  `lvis-plugin.json` for the LVIS runtime and, later, a standard-conformant
  `plugin.json` whose `extensions["ai.lvis.plugin"]` points at ours. Interop becomes
  additive instead of either/or.
- Loader keeps a one-release dual-read (`lvis-plugin.json` preferred, `plugin.json`
  accepted with a deprecation log) so installed plugins and the marketplace pipeline
  migrate without a flag-day; the Plugin Doctor reinstall path auto-heals stragglers.
  The dual-read is removed the release after the marketplace republishes.
- The signed-zip format versions once (manifest filename is part of the signed
  content); re-sign rides the next ordinary plugin release wave.

### 3.3 Two-layer schema discipline (keeps the door open)

Inside `lvis-plugin.json`, keep the already-MCP-aligned core (name/version/
description/tools as pure MCP `Tool` objects) cleanly separable from LVIS-only keys
(`_meta["lvisai/*"]`, uiResources, pluginAccess, …). Rule going forward: **new
LVIS-only manifest surface lands under a namespaced key, never a new bare top-level
key.** If adoption is ever decided, the core layer maps onto the standard's ten keys
and the LVIS layer moves wholesale under one `extensions` namespace — a projection,
not a redesign.

### 3.4 What we explicitly do NOT do now

- No standard-format emission, no `skills/` restructuring, no `${PLUGIN_ROOT}`/
  `${PLUGIN_DATA}` provisioning — those only matter on adoption, which is not decided.
- No identifier/IPC renaming wave. Vocabulary and file identity only.

## 4. Decision points for the owner

1. Working name for the LVIS unit (§3.1): package / applet / extension / keep "plugin"
   with the file rename only.
2. Approve the manifest file rename + one-release dual-read (§3.2), and its placement
   in the release train (rides a normal plugin release wave; no dedicated flag-day).
3. Whether the marketplace listing vocabulary changes in the same wave or later.

## 5. Tracking

Re-evaluate the standard when any of: it tags a stable release; a currently-absent
major ecosystem participant adopts it; or our host needs to load a third-party
standard-format directory. Until then this proposal's §3.2/§3.3 keep both futures
cheap.
