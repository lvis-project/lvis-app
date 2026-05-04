# Agent Hub plugin v0.2.0 Release Runbook

## Pre-flight checklist

- [ ] All W3 PRs merged (Lane 5 / 6 / 9 / R1 / R2 / R3 / B1 / B2 / P1)
- [ ] main green on both lvis-plugin-agent-hub + lvis-app + lvis-marketplace
- [ ] dist/ui/agent-hub-panel-v3.js > 50 KB confirms real React tree
- [ ] 213 vitest tests + 18 cards tests + Lane 9 integration tests pass

## R5 mitigation — marketplace cache invalidate

Plan §R5 risk: cached 0.1.27 manifest install attempts to mount
`dist/ui/agent-hub-panel.js` after 0.2.0 publish — module-not-found
silent fail (v2.1 entry deleted in 0.2.0).

### Steps

1. **Publish v0.2.0 to marketplace** with explicit version-bump signal:
   - Set `manifest.versionMajorBump: true` (or equivalent flag if marketplace API supports)
   - Force re-fetch on all installs of v0.1.x

2. **Host plugin loader force-reload check**:
   - On host startup, if cached manifest version != installed version,
     re-fetch manifest before mount.
   - Check entry path delta: if `ui[0].entry` changed, invalidate cache.

3. **Smoke test** (Lane 9/app spec — `r5-cache-invalidate.spec.ts`):
   - Pre-publish: install 0.1.27, mount panel, verify entry = `agent-hub-panel.js`
   - Post-publish: bump to 0.2.0, restart host, verify entry = `agent-hub-panel-v3.js`
   - Assert no silent fail in console / toast notifications

4. **Rollback plan**:
   - If silent fail observed in production, push 0.2.1 hotfix that re-adds
     a stub `dist/ui/agent-hub-panel.js` redirecting to v3 entry.

5. **Communication**:
   - Marketplace release notes mention "host restart recommended after update"
   - Plugin Settings panel shows "v0.2.0 ready — please restart" banner
     for 24h post-publish (optional UX)

## Release tag push

```bash
cd lvis-plugin-agent-hub
git checkout main && git pull --ff-only
git tag v0.2.0 -m "v0.2.0 — UI v3 GA + Lane 1-9 unified"
git push origin v0.2.0
```

## Marketplace catalog entry

Companion PR in `lvis-marketplace` (Phase C-2) — adds agent-hub@0.2.0
catalog entry pointing at the new tag.

## Post-release verification

- Active install count vs v0.2.0 update count (24h after publish)
- Sentry/audit log: silent mount-fail rate
- TODO.md update: Lane 1-9 done, Phase E v0.2.1 sprint open
