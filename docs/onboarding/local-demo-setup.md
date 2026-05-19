# LVIS Local Demo Setup

This guide covers the LGE internal demo loop (Path 2). Demo mode lets a new
user click **"데모 자격증명으로 30초 안에 체험"** in the Login modal and have the
app silently provision an LLM key + endpoint without typing anything.

## How demo mode is activated

Demo mode is activated by environment variables read at boot. The `LoginModalConversational`'s demo chip auto-fires `loginMockup` with the
hard-coded `demo` / `demo123` mockup credentials; the IPC handler then
looks up the per-vendor API key from `LVIS_DEMO_KEY_<VENDOR>` and persists
it into the encrypted secret store.

| Env var | Purpose |
|---|---|
| `LVIS_DEMO_ENABLED=1` | Master gate. Without this, the IPC handler refuses to register in packaged builds. |
| `LVIS_DEMO_VENDOR=azure-foundry` | Top-level vendor the login activates (default is `azure-foundry` for LGE internal demo). |
| `LVIS_DEMO_KEY_AZURE_FOUNDRY=<api-key>` | The Azure Foundry API key to provision. |
| `LVIS_DEMO_BASEURL_AZURE_FOUNDRY=<endpoint>` | The Azure Foundry endpoint URL. |
| `LVIS_DEMO_MODEL_AZURE_FOUNDRY=<model>` | Optional model id override. |
| `LVIS_DEMO_HOST_MAP=<host>=<ip>,<host>=<ip>` | Comma-separated host→IP table for the Electron `host-resolver-rules` switch (see "Host mapping" below). |

These variables are scrubbed from `process.env` in packaged builds before
the renderer / preload / workers can observe them. The captured values
live in main-process module state only.

## Host mapping (LGE intranet)

The Azure Foundry demo endpoint (`aif-swc-axpg-hq-hckt19.*.azure.com`)
resolves only on the LGE intranet (10.182.192.0/24). Public DNS does not
return these IPs.

LVIS applies the mapping **inside Electron only** via the Chromium
`host-resolver-rules` command-line switch — no `/etc/hosts` mutation, no
sudo. The mapping is sourced from `LVIS_DEMO_HOST_MAP` and is applied at
boot iff `LVIS_DEMO_VENDOR=azure-foundry`.

Example value (LGE intranet IPs as of 2026-05-19):

```
LVIS_DEMO_HOST_MAP="aif-swc-axpg-hq-hckt19.cognitiveservices.azure.com=10.182.192.174,aif-swc-axpg-hq-hckt19.openai.azure.com=10.182.192.175,aif-swc-axpg-hq-hckt19.services.ai.azure.com=10.182.192.176"
```

When `LVIS_DEMO_VENDOR` is anything other than `azure-foundry`, the host
map is ignored (other vendors resolve via public DNS).

## Local launch — `.env.demo` setup

A template is committed at `.env.demo.example`. Copy it to `.env.demo`
(gitignored) and fill in the real credentials:

```bash
cp .env.demo.example .env.demo
# Open .env.demo and replace <paste-api-key-here> with the LGE-issued key.
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
LVIS_DEMO_ENABLED=1
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
- **Public network user (not on LGE intranet)** — the demo loop is
  intentionally intranet-only. Use the BYOK chip (`2`) to enter your own
  vendor API key via Settings → LLM tab.
