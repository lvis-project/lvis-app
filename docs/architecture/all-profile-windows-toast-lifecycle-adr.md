# All-Profile Windows Toast Artifact Lifecycle (per-machine installs)

Status: Proposed

- Issue: lvis-project/lvis-app#1643 (acceptance item 1: "select a reviewed machine-lifecycle design")
- Follows: #1628 (shipped exact invoking-user cleanup), #1627
- Scope of this ADR: choose a reviewed design only. It does NOT change
  `build/installer.nsh`, the cleanup script, or any runtime code. Implementation
  plus the two-Windows-user test keep #1643 open.
- Last updated: 2026-07-22

## What This Page Owns

This page owns the decision for how LVIS toast/notification artifacts
(per-user Start Menu shortcut + per-user toast-activator CLSID) are created and
removed across ALL Windows profiles for a per-machine (perMachine NSIS) install.
It is the first review surface for that decision. Source files and tests are
authoritative when this prose and the implementation disagree.

## Problem

LVIS ships a per-machine NSIS installer (`oneClick:true` + `perMachine:true`;
all-users Program Files, HKLM ownership - `build/installer.nsh:158-163`). The
app files and protocol registration are machine-scoped, but the Windows toast
notification surface is per-user by design:

- On first launch, the main process pins a product-owned identity and toast
  activator CLSID: `app.setAppUserModelId("xyz.lvisai.app")` and, on Windows,
  `app.setToastActivatorCLSID(WINDOWS_TOAST_ACTIVATOR_CLSID)` where the CLSID is
  `{62FD3EFB-B3D2-4235-9402-6979F52C0286}`
  (`src/main/early-boot-env.ts:25-26,70-77`).
- Electron 43 then materializes two per-user artifacts the first time a
  notification presenter initializes, for EACH Windows user who runs the app:
  1. a Start Menu shortcut in that user's Programs known folder
     (`Environment.SpecialFolder.Programs`), carrying the AppUserModelID and the
     ToastActivatorCLSID (`build/uninstall-windows-notification-artifacts.ps1:388-392`);
  2. a per-user COM activator registration under
     `HKCU\Software\Classes\CLSID\{clsid}\LocalServer32` with root default
     `Electron Notification Activator`, `CustomActivator` DWord = 1, and
     `LocalServer32` default pointing at the installed executable
     (`build/uninstall-windows-notification-artifacts.ps1:186-223`).

  The in-code comments confirm this is Electron-driven and per-user:
  `build/installer.nsh:412-416` ("Electron 43 creates a current-user
  notification shortcut and HKCU toast activator registration even for a
  per-machine app") and `src/main/early-boot-env.ts:71-74`.

PR #1628 shipped a genuine-uninstall cleanup that removes ONLY the exact
artifacts owned by the user who runs the uninstaller. The uninstaller invokes
`un.lvisCleanupCurrentUserNotificationArtifacts`
(`build/installer.nsh:335-382`, dispatched at `:425-434`), which shells the
per-user PowerShell cleanup for the invoking identity - in the normal
alternate-admin UAC path it runs inside electron-builder's retained OUTER user
process via `UAC_AsUser_Call` (`build/installer.nsh:425-426`). The cleanup
targets the invoking user's Programs folder and HKCU hive only
(`build/uninstall-windows-notification-artifacts.ps1:241-256,332-356,388-392`).

Result: if user A installs and runs the app and user B also runs it, both
profiles get a shortcut + HKCU CLSID. A genuine uninstall performed by A removes
only A's pair; B's shortcut and HKCU CLSID survive as orphaned residue. #1628
explicitly disclaimed all-profile coverage; this is the follow-up.

## Current behavior evidence (what the code actually does)

Two points sharpen the picture beyond the issue text:

- The cleanup is provably ownership-scoped, not a broad delete. It fails closed
  and preserves anything that is not byte-exact LVIS: a same-target
  partial-owned shortcut is classified `foreign-preserved` and survives
  byte-for-byte (`build/uninstall-windows-notification-artifacts.ps1:405-420`,
  and the round-trip is asserted on a real `.lnk` in
  `test/scripts/smoke-windows-nsis-installer.test.ts:409-614`). Any per-value
  type/data mismatch on the CLSID keys aborts the delete
  (`...ps1:178-228,278-282`). So extending to other profiles inherits a strict,
  audited ownership test - the risk is which hives/folders we are allowed to
  reach, not the matching logic.
- Two independent updater guards already exist and MUST be preserved. Genuine
  uninstall vs. updater uninstall is branched by BOTH electron-builder's
  compile-time `${isUpdated}` and an explicit `--updated` GetOptions probe, in
  `customUnInstall` (`build/installer.nsh:402-410`, skipping to
  `lvis_skip_genuine_uninstall`) and again in `customRemoveFiles`
  (`build/installer.nsh:530,601-611`). The notification cleanup runs only on the
  genuine path, AFTER those guards. Any all-profile design must sit behind the
  same guards or it will strip activation during an auto-update.
- The current single-user smoke (`test/scripts/smoke-windows-nsis-installer.test.ts`)
  drives one user: install `/allusers`, assert exact protocol + owned-shortcut
  provenance, uninstall, then assert removal
  (`assertRuntimeNotificationArtifactsRemoved`, e.g. lines 1266+). There is no
  second-profile coverage today; the two-user test is net-new work.

## Hard constraints

Any accepted design MUST satisfy all of the following (from #1643 and the code):

1. No arbitrary enumeration or deletion across other users' profile hives. We
   must not load foreign `NTUSER.DAT` hives and sweep them, nor delete by
   guessing per-user paths. (This is the core reason the naive "just clean every
   profile" approach is rejected.)
2. Never touch foreign (non-LVIS) values or files. The exact-ownership contract
   from #1628 is non-negotiable and must extend unchanged: byte-exact match on
   target, working dir, empty args, description, AUMID, valid toast CLSID for
   shortcuts; exact type/data on the CLSID keys
   (`...ps1:124-166,178-228`).
3. Must work for a standard-user uninstall performed with alternate admin
   credentials - the common enterprise case. The current design already handles
   this by splitting elevated machine actions from the outer-user notification
   cleanup (`build/installer.nsh:425-429`); an all-profile design must not
   assume the uninstalling identity equals the profile that owns the residue.
4. macOS and Linux runtime and packaging paths untouched
   (`build/installer.nsh` is Windows-only; the CLSID write is guarded by
   `process.platform === "win32"` at `src/main/early-boot-env.ts:75`).
5. Must NOT regress the merged updater-path preservation. Both `${isUpdated}`
   and the explicit `--updated` guard must continue to short-circuit BEFORE any
   notification/CLSID teardown (`build/installer.nsh:402-410,530,601-611`).
6. Must NOT regress the invoking-user cleanup #1628 shipped. All-profile
   coverage is additive; the exact invoking-user delete/reinstall path stays
   green.
7. Must not brick install/uninstall. Notification provisioning/cleanup is
   non-fatal-by-posture elsewhere (e.g. the sandbox provisioning at
   `build/installer.nsh:173-175`); an all-profile mechanism should not turn a
   cosmetic residue into an install/uninstall Abort for foreign-profile edge
   cases it cannot safely reason about.

## Candidate designs

### Option A - Machine-owned toast registration + Electron opt-out/upstream

Idea: make the toast activator machine-scoped so there is ONE artifact set the
per-machine uninstaller already owns, instead of N per-user pairs. Concretely:
the installer would write an all-users Start Menu shortcut (ProgramData Programs)
carrying the AUMID + ToastActivatorCLSID, and register the activator CLSID under
`HKLM\Software\Classes\CLSID\{clsid}\LocalServer32`; the app would be told NOT to
create its own per-user shortcut/CLSID.

Feasibility against current Electron (43):

- `app.setToastActivatorCLSID()` exists and we already use it
  (`src/main/early-boot-env.ts:76`) - but it only pins WHICH CLSID Electron
  writes; it does not change WHERE. Electron's notification presenter still
  creates the per-user Start Menu shortcut in the user's Programs folder and
  registers the CLSID in HKCU when it initializes. There is no current Electron
  API to (a) point notifications at a machine-wide/all-users registration, or
  (b) opt out of the per-user shortcut+CLSID creation. That is exactly the
  "Electron opt-out/upstream support" the issue names as a prerequisite.
- Windows itself: for classic (non-MSIX) Win32 apps, toast delivery requires an
  AppUserModelID shortcut. Windows can resolve the activator CLSID from HKLM as
  well as HKCU, and an all-users Start Menu shortcut is visible to every profile,
  so a machine-scoped registration is technically expressible at the OS level.
  The blocker is not Windows; it is that Electron unconditionally recreates the
  per-user pair, so without an upstream change every profile would STILL get an
  HKCU CLSID + per-user shortcut and we would be back to N-artifact cleanup.

Tradeoffs:

- Pro: collapses the lifecycle to machine-owned state the perMachine uninstaller
  already deletes fail-closed (same class as the HKLM protocol keys at
  `build/installer.nsh:242-255,613-641`). No foreign-hive enumeration needed -
  satisfies constraint 1 cleanly.
- Pro: aligns with the existing HKLM ownership posture and the exact-match
  cleanup machinery we already trust.
- Con: hard dependency on upstream Electron. Until an opt-out/redirect API lands
  and we upgrade to it, we cannot actually stop the per-user artifacts, so this
  option does NOT by itself close #1643 today. It requires filing/adopting an
  upstream Electron feature and pinning the version that carries it.
- Con: partial/interim variants (installer writes the HKLM CLSID + all-users
  shortcut while Electron still writes HKCU) increase, not decrease, the artifact
  surface and reintroduce per-user residue - net negative until the opt-out
  exists.
- Con: an all-users Start Menu shortcut is itself new machine state to own,
  version, and clean; getting its AUMID/CLSID/property-store bytes exactly right
  across Electron upgrades is fragile.

### Option B - MSIX/AppX packaging (OS-managed per-user lifecycle)

Idea: ship an MSIX/AppX package. The OS registers per-user notification identity
from the package manifest and tears down all per-user state on uninstall/removal
automatically, so LVIS never hand-manages shortcuts or CLSIDs.

Tradeoffs:

- Pro: correct-by-construction all-profile lifecycle; no bespoke cleanup, no
  foreign-hive reasoning. This is the "right" long-term Windows answer.
- Con: explicitly deferred by product/release policy. The release checklist
  states MSIX/AppX is a separate packaging decision and forbids shipping it
  alongside NSIS "until the update mechanism, signing certificate/Partner Center
  path, and enterprise distribution requirements are decided"
  (`docs/references/production-release-checklist.md:185-187`).
- Con: preconditions are unmet today. The public release path is currently
  explicit-unsigned (`docs/references/production-release-checklist.md:86-108`);
  MSIX requires a trusted signing identity, and separately a Partner Center /
  enterprise distribution and an MSIX-compatible update mechanism (electron-
  updater's NSIS `latest.yml` flow, `production-release-checklist.md:203-208`,
  does not manage AppX).
- Con: large, cross-cutting migration (packaging, signing, update, sandbox/ASRT
  provisioning which today runs from the elevated NSIS installer at
  `build/installer.nsh:176-227`). Out of proportion to a toast-residue fix and
  blocked on decisions above LVIS engineering.

## Decision / Recommendation

Recommended: a phased path with Option A as the strategic target, gated behind
upstream Electron support, and NO interim broad-cleanup hack. Option B (MSIX) is
recorded as the eventual correct end-state but stays deferred under existing
policy and is out of scope for #1643.

Rationale tied to constraints:

- Option A is the only candidate that both closes the gap and honors constraint
  1 (no foreign-hive enumeration): it removes the per-user artifacts at the
  source instead of chasing them across profiles. It composes with the existing
  exact-ownership cleanup and HKLM ownership posture rather than fighting them.
- Option B is strictly blocked by documented, non-engineering decisions
  (`production-release-checklist.md:185-187`), so it cannot be the answer that
  unblocks #1643 now.
- A broad "enumerate every profile and delete" implementation is rejected
  outright by constraint 1 and by the fail-closed philosophy already encoded in
  the cleanup (`...ps1:526-534`).

Phasing:

1. Step 0 (this ADR): record the decision. Keep #1628's invoking-user cleanup
   as the shipped behavior; the second user's residue is a known, documented gap
   (cosmetic: an orphaned Start Menu shortcut + inert HKCU CLSID, not a security
   or data-loss issue).
2. Step 1 (upstream): file/track an Electron feature request for an
   opt-out/redirect so a Win32 app can suppress per-user shortcut+CLSID creation
   in favor of a machine-registered activator. Pin the Electron version that
   carries it. This is the true unblock for constraint-1-safe all-profile
   cleanup.
3. Step 2 (adopt): once upstream lands, have the installer own the all-users
   shortcut + HKLM CLSID, switch `early-boot-env.ts` to the opt-out API, and
   extend the perMachine uninstaller's fail-closed machine-state teardown to
   that single artifact set (reusing the `lvisDeleteExactEmptyRegistryKey` /
   exact-match discipline at `build/installer.nsh:113-148`).
4. Land the two-Windows-user acceptance test (below) with Step 2. #1643 stays
   OPEN until that test is green.

Interim stance while Step 1 is pending: do not attempt cross-profile deletion.
If a low-risk, constraint-compliant improvement is wanted before upstream lands,
the only safe candidate is opportunistic self-cleanup - each user's own next app
launch (or its own uninstall) already owns its HKCU hive and Programs folder, so
a first-run/again reconciliation could retire that user's stale pair without ever
touching a foreign hive. This is optional and not required to select the design.

## Migration and rollback outline

Migration (applies when Step 2 is implemented, not now):

- Forward: new installs write the machine-owned registration; the app uses the
  Electron opt-out so no per-user pair is created. Existing installs that already
  left per-user pairs in other profiles are reconciled by each profile's own
  next launch/uninstall (never by cross-hive sweeps). The pinned CLSID
  (`src/main/early-boot-env.ts:26`) is unchanged so old and new registrations
  share identity and remain exact-matchable.
- Guard alignment: the new machine teardown must be inserted on the genuine-
  uninstall path only, behind the existing `${isUpdated}` / `--updated` guards
  (`build/installer.nsh:402-410,601-611`), matching where notification cleanup
  already sits.

Rollback:

- The design is additive and behind a version pin, so rollback is reverting the
  installer/`early-boot-env.ts` change and un-pinning the Electron version;
  behavior returns to today's #1628 invoking-user cleanup with no schema or
  on-disk migration to undo (the CLSID and marker contracts are unchanged).
- Release-level rollback follows the existing procedure: move the GitHub Release
  to draft and restore `latest.yml`
  (`docs/references/production-release-checklist.md:203-208`).

## Acceptance mapping (what keeps #1643 open)

- [x] Item 1: reviewed machine-lifecycle design selected (this ADR).
- [ ] Item 2: implementation (Step 2, pending upstream Electron support).
- [ ] Item 3: two-Windows-user test - install per-machine, run the app as user A
      and user B (materializing both pairs), perform a genuine DELETE uninstall
      as one user (including the alternate-admin-cred case), and assert NO
      LVIS-owned shortcut or HKCU CLSID remains for EITHER user, while foreign
      values stay byte-for-byte. Extends
      `test/scripts/smoke-windows-nsis-installer.test.ts`.
- [ ] Item 4: updater uninstall preserves activation (regression guard on
      `build/installer.nsh:402-410,601-611`).
- [x] Item 5: migration and rollback documented (above).

## Implementation Anchors

- `build/installer.nsh` (`customUnInstall`, `un.lvisCleanupCurrentUserNotificationArtifacts`, updater guards)
- `build/uninstall-windows-notification-artifacts.ps1` (exact-ownership cleanup contract)
- `src/main/early-boot-env.ts:25-77` (AUMID + pinned toast CLSID)
- `test/scripts/smoke-windows-nsis-installer.test.ts` (single-user smoke; two-user test to be added)
- `docs/references/production-release-checklist.md:185-187` (MSIX deferral)

## Related Entry Points

- [Architecture](./README.md)
- [Production Release Checklist](../references/production-release-checklist.md)
