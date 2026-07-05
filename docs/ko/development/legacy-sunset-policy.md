# Legacy Sunset Policy

This policy makes migration and dormant experimental code explicit instead of
letting it stay on every boot and test path indefinitely.

## Support Floor

- Minimum supported application version for this inventory: `0.4.4`.
- Migration code must stay until both time and release criteria are met:
  - at least 90 days after the migration was introduced;
  - at least two released app versions after the migration first shipped;
  - data-preservation tests still pass before removal;
  - release notes or support telemetry show no active downgrade/import path that
    still depends on the migration.

## Required Inventory Fields

Every migration or dormant experimental surface must have an entry in
[`legacy-sunset-inventory.json`](./legacy-sunset-inventory.json). The inventory is
checked by `bun run check:sunset-inventory`.

Required fields:

- `id`, `kind`, `status`, `owner`, `introduced`, and `rationale`
- `codeReferences` with existing repository paths
- `validation` commands that prove the current behavior or isolation boundary
- `sunsetCriteria` explaining what must be true before deletion or promotion

For `kind: "migration"`, the entry must also include a `sunsetNotBefore` date and
at least one data-preservation test. For `status: "experimental-isolated"`, code
must live under an `experimental/` path or the entry must name an explicit
`featureFlag`.

## Current Decisions

| Surface | Decision |
| --- | --- |
| Work board legacy plugin-board migration | Keep. It is boot-time, but one-shot and data-preserving. Removal is blocked until the support floor expires and the copy/idempotency tests pass in the removal PR. |
| Permission reviewer `disabled` migration | Keep. It prevents a silent security downgrade for pre-#664 settings files. Removal needs an explicit migration sunset issue because old settings can persist across app upgrades. |
| Permission `allowedDirectories` alias convergence | Keep the write-time scrub only. Read-time behavior already ignores the legacy alias, and writes converge the file to `additionalDirectories`. |
| MCP stdio out-of-process transport | Isolate as experimental. The serving loop and child transport are tested, but not production-wired; they now live under `src/mcp/experimental/` until promoted behind a feature flag or deleted. |

## Removal PR Rule

Deletion should be its own PR unless the inventory entry is purely documentary.
The removal PR must:

1. Link the inventory entry.
2. Remove the inventory entry.
3. Keep or add a regression test proving user data is not lost.
4. Run the validation command named by the entry.
