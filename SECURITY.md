# Security Policy

## Supported versions

Only the latest released version on the [GitHub Releases page](https://github.com/lvis-project/lvis-app/releases)
receives security fixes. There is no LTS branch.

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public
GitHub issue.

**Contact**: `jo.dreame@gmail.com`

Include:
- LVIS version (or git commit hash if running from source)
- Affected component (host app, plugin, marketplace, MCP, etc.)
- Reproduction steps + proof-of-concept if possible
- Impact assessment (information disclosure, code execution, privilege
  escalation, denial of service)
- Your preferred disclosure timeline

## What to expect

| Phase | Target |
|---|---|
| Acknowledgement | within 5 business days |
| Initial triage + severity | within 10 business days |
| Fix released or mitigation documented | depends on severity (see below) |

**Severity targets:**
- **Critical** (remote code execution, sandbox escape, credential theft): patch within 14 days
- **High** (privilege escalation, sensitive data exposure): patch within 30 days
- **Medium / Low**: addressed in the next regular release cycle

## Scope

In scope:
- LVIS desktop app (this repository)
- The plugin SDK and bundled plugins shipped with each release
- Marketplace fetcher behavior and bundled plugin verification
- Tool execution sandbox, permission gates, and approval flow
- Auto-update verification (signature, manifest, integrity)

Out of scope (handle directly via upstream):
- Electron framework vulnerabilities → Electron security team
- Node.js / V8 / Chromium runtime issues → respective upstreams
- Operating system or third-party software interactions
- Vulnerabilities in third-party plugins not bundled with the release

## Coordinated disclosure

We follow a 90-day disclosure deadline by default, adjustable by mutual
agreement based on patch availability and risk to users. We credit
reporters in release notes unless anonymity is requested.

## Notes on the security model

- All on-disk data under `~/.lvis/` uses 0o700 for directories and 0o600
  for files. Secrets are additionally encrypted via the OS keychain
  (`safeStorage`).
- Tool execution passes through a multi-stage permission gate (`approval-gate`,
  `permission-manager`, sandbox runner on macOS/Windows where available).
- Marketplace artifacts are verified against signed manifests when the
  `corp-portal-template` capability is configured; verify the threat model
  in `docs/architecture/permission-policy-design.md` before deploying in
  a regulated environment.

If you find a defect in any of these guarantees, please report it.
