# Demo Activation Code — Internal Distribution Guide

This guide covers the **activation code** path for the LVIS internal
organization demo loop. Use this path when a user receives a
single-line activation string through an internal channel (Confluence,
SharePoint, chat) instead of a checked-out repo with a `.env.demo`
file.

> For local development (cloning the repo, running `bun run start`), see
> [`local-demo-setup.md`](./local-demo-setup.md). The local path lets a
> developer drop a `.env.demo` file at the repo root directly; this
> document covers the **packaged-app distribution** path where end users
> never touch the file system.

## End-user flow

1. The user receives a single-line activation string from the internal
   demo owner. Format:

   ```
   LVIS-DEMO:v1:<base64url-payload>
   ```

2. The user launches LVIS. The Login modal opens automatically on first
   launch.

3. The user clicks **"데모 자격증명으로 30초 안에 체험"** (chip 1, or
   presses `1`).

4. The modal enters the **activation-input sub-state**. The assistant
   bubble asks: *"데모 활성 코드를 받으셨나요? 한 줄로 붙여넣어 주세요. 형식은 `LVIS-DEMO:v1:...` 입니다."*

5. The user pastes the activation string into the textarea and clicks
   **"활성 →"** (or presses Enter).

6. The main process decrypts the string back into the original
   `.env.demo` payload, persists it to
   `~/Library/Application Support/...` → actually
   `~/.lvis/secrets/.env.demo` (mode `0o600`), and injects the values
   into `process.env`. The `LVIS_DEMO_*` capture is re-run so the auth
   handler observes the new keys.

7. The modal paints an explicit relaunch notice:
   *"활성화 적용을 위해 5초 후 자동으로 다시 시작합니다. 다시 시작 후 AI
   연결 상태를 확인합니다."* After the 5-second dwell, the renderer calls the
   armed relaunch IPC so the next process starts with the host resolver env
   already loaded.

8. After the app restarts, the user clicks **chip 1** again. Because the
   persisted `.env.demo` was loaded at boot, the activation input is skipped
   and the existing `loginMockup` chain runs immediately — credentials
   validation → LLM key issuance → sandbox preparation → handoff. The user
   lands in the chat surface authenticated as the Azure Foundry demo vendor.

## On subsequent launches

The `.env.demo` payload persisted in step 6 is auto-loaded by `main.ts`
at boot (`loadPersistedDemoActivationSync()`), so the user does **not**
re-enter the activation code. They simply launch the app and click
**chip 1**; the `loginMockup` chain runs immediately because the env
vars are already in place.

To **reset** the activation, delete the persisted file:

```bash
rm ~/.lvis/secrets/.env.demo
```

After deletion the user is prompted for the activation string again on
the next chip 1 click.

## Generating an activation string (demo-owner workflow)

The demo owner produces an activation string by encrypting a plaintext
`.env.demo` file with the `scripts/encrypt-demo-credentials.mjs` CLI
tool. The tool uses the same codec the main process uses to decrypt, so
there is no drift between encrypt and decrypt.

```bash
# 1. Prepare the plaintext .env.demo (use .env.demo.example as a template).
cp .env.demo.example .env.demo
# Edit .env.demo and fill in real LVIS_DEMO_KEY_AZURE_FOUNDRY, etc.

# 2. After `bun run build`, the codec is at dist/. Run the script:
node scripts/encrypt-demo-credentials.mjs .env.demo

# Output (single line, copy to clipboard):
# LVIS-DEMO:v1:<base64url-payload>

# 3. Save to a file instead of stdout:
node scripts/encrypt-demo-credentials.mjs --in .env.demo --out activation.txt
```

Distribute the resulting `LVIS-DEMO:v1:<...>` string through your
internal channel of choice. The string is URL-safe so chat clients
won't mangle it, but if your channel auto-wraps long lines, attach the
string as a code block or text file.

## Security model

The activation codec is **deliberately low-strength** crypto with a
hardcoded master passphrase reconstructed from obfuscated chunks at
runtime. The threat model is:

| Attacker capability | What the codec resists |
|---|---|
| Sees the activation string only (Confluence scrape) | ✔ Cannot decrypt without the LVIS binary. |
| Has the LVIS binary only (no activation string) | ✔ Cannot synthesise valid demo credentials. |
| Has BOTH the binary AND the activation string | ✘ Can decrypt (acknowledged). |
| Has the binary AND wants to bypass via `strings` sweep | ✔ Master passphrase fragments not contiguous in the binary. |

**Real production secrets** (per-user OAuth tokens, customer API keys)
**MUST NOT** be distributed through this codec. The activation flow is
strictly for the internal organization demo loop where the embedded
demo API key is the *only* thing protected, and the protection is
**delivery-channel control** (who has the activation string), not
cryptographic strength.

To rotate the master passphrase: bump `ACTIVATION_PREFIX` to `v2`, add
a new decode path that uses the new passphrase, and keep the v1 path
alive for backward compatibility until every issued string has been
re-issued. The `scripts/encrypt-demo-credentials.mjs` script picks up
the new prefix automatically.

## Errors surfaced to the user

The IPC handler returns kebab-case English error codes; the renderer
translates each to a Korean message inside the activation input bubble:

| Code | Cause | Korean surface |
|---|---|---|
| `invalid-code` | Wrong prefix, corrupt base64, GCM auth-tag mismatch (wrong passphrase / tampered ciphertext), empty input | "활성 코드가 올바르지 않아요. `LVIS-DEMO:v1:` 로 시작하는 한 줄 코드를 다시 확인해 주세요." |
| `no-vendor` | Decrypted payload missing `LVIS_DEMO_VENDOR` | "활성 코드에 vendor 정보가 빠져 있어요. 발급자에게 다시 요청해 주세요." |
| `invalid-vendor` | Decrypted payload has an unknown `LVIS_DEMO_VENDOR` | "활성 코드의 vendor 정보가 올바르지 않아요. 발급자에게 다시 요청해 주세요." |
| `persist-failed` | Filesystem write failure (permission/disk) | "활성 코드를 저장하지 못했어요. 디스크 공간 또는 권한을 확인한 뒤 다시 시도해 주세요." |
| `unauthorized-frame` | IPC sender frame rejected (should never happen in production) | "잘못된 요청 경로입니다. 앱을 재시작한 뒤 다시 시도해 주세요." |

The activation input remains editable on failure so the user can fix a
typo and retry without re-entering chip 1.

## Files involved

| File | Responsibility |
|---|---|
| `src/main/demo-activation-codec.ts` | AES-256-GCM encrypt/decrypt + `.env.demo` parser + sync boot loader. |
| `src/ipc/domains/demo.ts` | `lvis:demo:activate` IPC handler — decrypt + persist + inject + recapture. |
| `src/main/demo-credentials.ts` | Adds `recaptureDemoCredentialsAfterActivation()` for post-activation env re-scan. |
| `src/main.ts` | Calls `loadPersistedDemoActivationSync()` before `captureDemoCredentials()` at boot. |
| `src/preload.ts` | Exposes `api.demo.activate(code)` to the renderer. |
| `src/ui/renderer/components/LoginModalConversational.tsx` | Activation input sub-state + Korean error translation + F5 explicit ack. |
| `scripts/encrypt-demo-credentials.mjs` | CLI tool to turn a `.env.demo` file into an activation string. |
