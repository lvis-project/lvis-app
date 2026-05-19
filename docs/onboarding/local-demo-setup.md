# LVIS Local Demo Setup

This guide covers the internal organization demo loop (Path 2). Demo mode lets a new
user click **"데모 자격증명으로 30초 안에 체험"** in the Login modal and have the
app provision an LLM key + endpoint.

There are **two activation paths**:

| Path | When to use |
|---|---|
| **A. Local `.env.demo` file** (this document) | You cloned the repo and run `bun run start` locally. Drop a `.env.demo` at the repo root; `scripts/run-electron.mjs` auto-loads it. |
| **B. Activation code** (see [`demo-activation.md`](./demo-activation.md)) | You received the LVIS packaged app + a single-line `LVIS-DEMO:v1:<...>` activation string through an internal channel. The Login modal accepts the string and persists the decrypted `.env.demo` to `~/.lvis/secrets/.env.demo` for subsequent boots. |

Both paths converge on the same runtime — once the env vars are in place
(via `.env.demo` autoload OR activation-string decrypt), the same
`captureDemoCredentials()` pipeline observes them and the same
`loginMockup` IPC handler provisions the keys.

> **Host mapping is handled at the app level — no `/etc/hosts` edits, no
> sudo.** When `LVIS_DEMO_VENDOR=azure-foundry` and `LVIS_DEMO_HOST_MAP`
> is non-empty, the Electron main process installs a Chromium
> `host-resolver-rules` command-line switch at boot so the demo Azure
> Foundry hostnames resolve to the configured intranet IPs *inside the
> Electron process only*. The mapping never escapes Electron and never
> touches the host OS. See [Host mapping (intranet)](#host-mapping-intranet)
> below and `src/main/demo-host-resolver.ts` for the implementation.

## How demo mode is activated

Demo mode is activated by environment variables read at boot. The `LoginModalConversational`'s demo chip auto-fires `loginMockup` with the
hard-coded `demo` / `demo123` mockup credentials; the IPC handler then
looks up the per-vendor API key from `LVIS_DEMO_KEY_<VENDOR>` and persists
it into the encrypted secret store.

Demo mode is activated implicitly when `captureDemoCredentials()` finds at
least one `LVIS_DEMO_KEY_<VENDOR>` entry in `process.env` at boot — no
separate gate variable is required. In packaged builds the mockup IPC
handler still refuses to register unless a key was captured pre-scrub.

| Env var | Purpose |
|---|---|
| `LVIS_DEMO_VENDOR=azure-foundry` | Top-level vendor the login activates (default is `azure-foundry` for the internal organization demo target). |
| `LVIS_DEMO_KEY_AZURE_FOUNDRY=<api-key>` | The Azure Foundry API key to provision. |
| `LVIS_DEMO_BASEURL_AZURE_FOUNDRY=<endpoint>` | The Azure Foundry endpoint URL. |
| `LVIS_DEMO_MODEL_AZURE_FOUNDRY=<model>` | Optional model id override. |
| `LVIS_DEMO_HOST_MAP=<host>=<ip>,<host>=<ip>` | Comma-separated host→IP table for the Electron `host-resolver-rules` switch (see "Host mapping" below). |

These variables are scrubbed from `process.env` in packaged builds before
the renderer / preload / workers can observe them. The captured values
live in main-process module state only.

## Host mapping (intranet)

The Azure Foundry demo endpoint (`aif-swc-axpg-hq-hckt19.*.azure.com`)
resolves only on the internal organization intranet (10.182.192.0/24).
Public DNS does not return these IPs.

LVIS applies the mapping **inside the Electron process only** via the
Chromium `host-resolver-rules` command-line switch — **no `/etc/hosts`
mutation, no sudo, no system-wide state change**. The switch is appended
in `src/main/demo-host-resolver.ts` before `app.whenReady()`; once
Chromium's network service spins up the command line is frozen. The
mapping is sourced from `LVIS_DEMO_HOST_MAP` and is applied at boot iff
`LVIS_DEMO_VENDOR=azure-foundry`.

Example value (intranet IPs as of 2026-05-19):

```
LVIS_DEMO_HOST_MAP="aif-swc-axpg-hq-hckt19.cognitiveservices.azure.com=10.182.192.174,aif-swc-axpg-hq-hckt19.openai.azure.com=10.182.192.175,aif-swc-axpg-hq-hckt19.services.ai.azure.com=10.182.192.176"
```

Mapping summary applied automatically when the env conditions are met:

| Hostname | Intranet IP |
|---|---|
| `aif-swc-axpg-hq-hckt19.cognitiveservices.azure.com` | `10.182.192.174` |
| `aif-swc-axpg-hq-hckt19.openai.azure.com` | `10.182.192.175` |
| `aif-swc-axpg-hq-hckt19.services.ai.azure.com` | `10.182.192.176` |

When `LVIS_DEMO_VENDOR` is anything other than `azure-foundry`, the host
map is ignored (other vendors resolve via public DNS). Confirm activation
by looking for the `[demo-host-resolver] mapping applied: N host(s)` line
in the main-process log; absence of that line means the switch was
skipped (vendor mismatch, demo disabled, or empty map).

## Local launch — `.env.demo` setup

A template is committed at `.env.demo.example`. Copy it to `.env.demo`
(gitignored) and fill in the real credentials:

```bash
cp .env.demo.example .env.demo
# Open .env.demo and replace <paste-api-key-here> with the internal-issued demo key.
```

`scripts/run-electron.mjs` automatically loads `.env.demo` when the file is
present in the repo root, so **no manual `source` is required**:

```bash
bun run start   # .env.demo is picked up automatically
```

If you prefer to export variables manually (e.g. in a wrapper script):

```bash
source .env.demo && bun run start
```

Full variable reference for `.env.demo`:

```bash
LVIS_DEMO_VENDOR=azure-foundry
LVIS_DEMO_KEY_AZURE_FOUNDRY=<paste-api-key-here>
LVIS_DEMO_BASEURL_AZURE_FOUNDRY=https://aif-swc-axpg-hq-hckt19.openai.azure.com/openai/v1/
LVIS_DEMO_MODEL_AZURE_FOUNDRY=gpt-4o
LVIS_DEMO_HOST_MAP=aif-swc-axpg-hq-hckt19.cognitiveservices.azure.com=10.182.192.174,aif-swc-axpg-hq-hckt19.openai.azure.com=10.182.192.175,aif-swc-axpg-hq-hckt19.services.ai.azure.com=10.182.192.176
```

When the Login modal opens, click the green **"데모 자격증명으로 30초 안에 체험"**
chip (or press `1`). The chip auto-fires `loginMockup`, persists the key
to the keychain, flips top-level `authMode=login` + `provider=azure-foundry`,
and closes the modal.

## Troubleshooting

- **`로그인 처리 중 오류가 발생했습니다.`** — IPC channel error. Check the
  main-process log for the underlying exception.
- **`데모 모드 설정 확인이 필요해요. 환경 변수 LVIS_DEMO_VENDOR=azure-foundry …`** —
  `LVIS_DEMO_KEY_AZURE_FOUNDRY` is unset or `LVIS_DEMO_VENDOR` is not `azure-foundry`.
  Create or source `.env.demo` before launch (`bun run start` does this automatically
  when the file is present in the repo root).
- **`데모 자격증명이 올바르지 않습니다.`** — the renderer chip used the wrong
  username/password. Should never happen with the chip-driven flow; if it
  does, file an issue with the auth audit log.
- **Network errors reaching `aif-swc-axpg-hq-hckt19.*.azure.com`** —
  verify `LVIS_DEMO_HOST_MAP` is set AND `LVIS_DEMO_VENDOR=azure-foundry`.
  The main-process log emits `[demo-host-resolver] mapping applied: N
  host(s)` when the switch is installed; absence of that line means the
  switch was skipped (vendor mismatch or empty map).
- **Public network user (not on the organization intranet)** — the demo
  loop is intentionally intranet-only. Use the BYOK chip (`2`) to enter
  your own vendor API key via Settings → LLM tab.
