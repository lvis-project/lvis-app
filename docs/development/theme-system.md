# LVIS Theme System

> **Status:** UX Track 3 (initial release).
> **Source of truth:** `src/styles.css` (tokens) + `src/ui/renderer/theme/` (provider).

The LVIS app ships with a single semantic-token theme system. Components do
**not** hard-code colors, spacing, or border radii. They consume *semantic*
tokens (`bg-background`, `text-foreground`, `text-muted-foreground`,
`bg-primary`, …), and a theme variant is a CSS-only remapping of those
tokens to underlying primitives.

This means:

- Switching themes requires zero component changes.
- Adding a new theme variant is **one** PR that touches CSS + a single
  TypeScript type union.
- Plugins that render inside the host webview will eventually consume the
  same semantic tokens (deferred — handled by a follow-up PR).

---

## 1. Token tier model

```
┌────────────────────────────────────────────────────────────┐
│  Components  ─►  Semantic tokens  ─►  Primitive tokens     │
│                                                            │
│  bg-primary       --primary             --p-blue-500       │
│  text-foreground  --foreground          --p-slate-50       │
│  border-border    --border              --p-slate-800      │
└────────────────────────────────────────────────────────────┘
```

- **Primitive tokens** (`--p-*`) live in `:root` of `src/styles.css`. They
  are raw HSL triples (no `hsl()` wrapper) so Tailwind's `bg-primary/30`
  alpha syntax keeps working.
- **Semantic tokens** (`--background`, `--foreground`, `--primary`,
  `--muted-foreground`, `--border`, `--ring`, `--destructive`, `--warning`,
  `--success`, …) live inside `[data-theme-bundle="<id>"]` blocks. Each bundle
  re-points its semantic tokens to a different set of primitives.
- **Components** consume semantic tokens **only**, via Tailwind v4 utilities
  exposed from the `@theme inline` block in `src/styles.css`
  (`bg-background`, `text-primary`, `border-border`, etc.). They never read
  `--p-*` directly.

The Tailwind utilities resolve at build time to `hsl(var(--background))`,
which means runtime CSS-variable swaps re-paint immediately without a
rebuild.

---

## 2. Theme bundles shipped

The user picks a bundle via Settings → 테마. Built-in bundle ids are defined
in `src/shared/theme-bundles.ts`; the fresh-install default is
`tokyo-night`. `followSystem` is a separate boolean, not a bundle id. When it
is enabled and the selected bundle is one of the violet light/dark pair, the
renderer resolves the active bundle from `prefers-color-scheme` and follows OS
changes live.

---

## 3. Provider + persistence

```
~/.lvis/settings.json
  └─ appearance.schemaVersion: 2
     appearance.bundleId       ←── persisted theme bundle id
     appearance.followSystem   ←── optional OS preference tracking
                                  │
                                  ▼
              ThemeProvider  (src/ui/renderer/theme/)
                                  │  resolves followSystem for violet pair
                                  ▼
              <html data-theme-bundle="…" data-shell="…" class="lvis-bundle-…">
                                  │
                                  ▼
                  [data-theme-bundle] block in styles.css
```

- `<ThemeProvider api={api}>` is mounted at the App composition root
  (`src/ui/renderer/App.tsx`).
- It calls `api.getSettings()` once on mount and applies the v2
  `appearance.bundleId` bundle. Failure to read settings is **not** fatal —
  the app boots with the default bundle.
- `setBundle()` writes `data-theme-bundle` / `data-shell` immediately and calls
  `api.updateSettings({ appearance: { schemaVersion: 2, bundleId } })` in the
  background.
- When `appearance.followSystem` is true, the provider listens to
  `matchMedia("(prefers-color-scheme: light)")` so OS-level toggles flow
  through with no reload.
- Test escape hatch: `useOptionalTheme()` returns `null` instead of
  throwing when no provider is mounted (Storybook / isolated snapshots).

---

## 4. Adding a new semantic token

Use case: "I need a `info-banner` color separate from `primary`."

1. Pick the semantic name. Use *meaning*, not appearance — `info`, not
   `cyan`. Two foreground/background pairs is the typical shape.
2. Add the variable to **every** `[data-theme-bundle="…"]` block in
   `src/styles.css`, pointing at an existing primitive (or add a new
   primitive if no existing one fits):

   ```css
   :root[data-theme-bundle="tokyo-night"] {
     /* existing tokens … */
     --info: var(--p-blue-400);
     --info-foreground: var(--p-slate-950);
   }
   :root[data-theme-bundle="violet-light"] { --info: var(--p-blue-600); --info-foreground: var(--p-slate-50); }
   :root[data-theme-bundle="high-contrast"] { --info: 200 100% 60%; --info-foreground: 0 0% 0%; }
   ```

3. Expose it in the `@theme inline` block in `src/styles.css`:

   ```css
   --color-info: hsl(var(--info));
   --color-info-foreground: hsl(var(--info-foreground));
   ```

4. Components can now use `bg-info text-info-foreground`.

The PR diff is CSS-only. No component changes.

---

## 5. Adding a new theme bundle

Use case: "I want a 'sepia' bundle for night reading."

1. Add the bundle id to `BUNDLE_IDS` in `src/shared/theme-bundles.ts`.
2. Add a `ThemeBundle` module under `src/ui/renderer/theme/bundles/` and
   register it in `src/ui/renderer/theme/bundles/index.ts`.
3. Add a `[data-theme-bundle="sepia"]` block in `src/styles.css` that remaps
   every semantic token. Copy from a similar bundle and tune.
4. AppearanceTab renders from the bundle registry; no separate options list
   should be hard-coded.
5. Run `bun run typecheck && bun run test`.

Done. No component edits.

---

## 6. Migrating a component

Before (hard-coded):

```tsx
<div className="bg-[#0c1322] text-[#f8fafc] border border-[#1e293b]">
  ...
</div>
```

After (semantic tokens):

```tsx
<div className="bg-card text-card-foreground border border-border">
  ...
</div>
```

Rules:

- **Surfaces:** `bg-background` (page) → `bg-card` (panel) →
  `bg-muted/40` (inset row).
- **Text:** primary copy = `text-foreground`; secondary/hint =
  `text-muted-foreground`; on a brand surface = `text-primary-foreground`.
- **Borders:** dividers + outlines = `border-border` (or just `border` —
  Tailwind utilities reference the semantic token by default).
- **Status:** `text-destructive` / `bg-destructive/10` for errors,
  `text-warning bg-warning/20` for warnings, `text-success` for success.
- **Focus rings:** `ring-ring` + `ring-offset-background` (already wired
  into `<Button>`, `<Input>`, etc.).

Anti-patterns:

- ❌ `text-white` / `text-black` (locks one theme).
- ❌ `bg-slate-800` / Tailwind palette utilities (skips the semantic layer).
- ❌ `style={{ color: "#fff" }}` (impossible to retheme).
- ❌ `dark:bg-slate-700` (redundant — semantic tokens already swap).

The shadcn primitives in `src/components/ui/` already follow this rule.
When in doubt, copy from `<Button>` or `<Card>`.

---

## 7. Migrated components (initial pass)

| Component | File | Notes |
|-----------|------|-------|
| App shell | `src/index.html`, `src/ui/renderer/App.tsx` | already uses `bg-background`/`text-foreground` |
| Top action bar | `src/ui/renderer/MainToolbar.tsx` | uses `bg-card border-b border-border` |
| Top bar | `src/ui/renderer/MainToolbar.tsx` | already `border-b` semantic |
| StatusBar | `src/ui/renderer/components/StatusBar.tsx` | already semantic |
| Buttons | `src/components/ui/button.tsx` | semantic via `cva` |
| Input | `src/components/ui/input.tsx` | semantic |
| Dialog | `src/components/ui/dialog.tsx` | semantic |
| Card / Popover / Tabs / Tooltip / Dropdown / ScrollArea / Separator | `src/components/ui/*` | all semantic — these are the shadcn primitives every other surface composes from |
| Settings dialog | `src/ui/renderer/SettingsDialog.tsx` | composed from semantic primitives |
| Settings tabs (Privacy, Audit, Roles, …) | `src/ui/renderer/tabs/*.tsx` | already semantic |

The hard-coded fallback toast in `App.tsx` (`bg-yellow-100 text-yellow-800
border-yellow-200`) was the last remaining literal Tailwind palette —
follow-up PRs should move that to the new `bg-warning text-warning-foreground`
semantic token.

---

## 8. UI primitive source of truth

Settings and renderer form controls use the shadcn registry primitives in
`src/components/ui/` as the canonical implementation layer. Local feature code
should compose those primitives instead of re-creating per-tab wrappers or
styling native controls directly.

Current canonical controls:

| Control | File | Expected use |
|---------|------|--------------|
| Checkbox | `src/components/ui/checkbox.tsx` | Boolean settings, acknowledgement rows, compact option toggles |
| Switch | `src/components/ui/switch.tsx` | Immediate on/off settings such as Appearance and LLM feature toggles |
| Select | `src/components/ui/select.tsx` | Styled Radix-backed choice controls that need trigger/content/item composition |
| NativeSelect | `src/components/ui/native-select.tsx` | Dense system-like select controls where native behavior is the intended UX |
| RadioGroup | `src/components/ui/radio-group.tsx` | Mutually exclusive settings where all options should stay visible |
| Slider | `src/components/ui/slider.tsx` | Numeric tuning controls such as token/reasoning budgets |
| Field / Label | `src/components/ui/field.tsx`, `src/components/ui/label.tsx` | Accessible label, hint, and validation layout around controls |

Rules:

- New renderer UI must import primitives from `src/components/ui/*` rather
  than defining local checkbox/select/switch/range/radio wrappers.
- Feature-specific components may still decide layout, copy, loading state, and
  domain behavior. They should not own primitive focus rings, checked states,
  menu item structure, or theme colors.
- shadcn registry setup is recorded in `components.json`; package imports
  (`#components/*`, `#lib/*`, `#hooks/*`) are the supported import shape for
  generated components in this Electron/Webpack repo.
- Reviewer-visible visual evidence for this control set lives in
  `docs/design/settings-controls-shadcn.html`.

---

## 9. Out of scope (handled separately)

- Plugin webview tokens — deferred. Plugins eventually need their iframes
  to consume host tokens; planned as a separate PR adding a CSS-variable
  bridge in `plugin-ui-shell.html`.
- TODO panel, floating question window, plugin install policy chips —
  parallel UX-track PRs own these surfaces; the migration there will land
  on top of this token base.
- Spacing/typography tokens — only color tokens are formalized in the
  initial pass. The existing Tailwind defaults (`p-3`, `text-sm`, …) are
  serving us well; promote them to tokens when there's a semantic reason
  (e.g. `gap-card`, `gap-section`).

---

## 10. References

- `src/styles.css` — token definitions
- `src/ui/renderer/theme/ThemeProvider.tsx` — provider + matchMedia hook
- `src/ui/renderer/theme/resolve-theme.ts` — `system` → concrete resolver
- `src/ui/renderer/tabs/AppearanceTab.tsx` — settings UI
- `src/components/ui/` — shadcn registry primitives
- `components.json` — shadcn registry configuration
- `docs/design/settings-controls-shadcn.html` — visual confirmation board
- `src/ui/renderer/__tests__/theme-provider.test.tsx` — provider tests
- `src/ui/renderer/__tests__/appearance-tab.test.tsx` — settings UI tests

---

## 11. Derived plugin-ui tokens (tinted surfaces + focus shadow)

Seven derived tokens were added to the plugin-ui contract
(`src/shared/plugin-ui-tokens.ts`) to eliminate the 79 cross-plugin
`color-mix()` reinventions found across the `--pm-*`, `--accent-bg`, and
`--ah-*` namespaces in meeting / local-indexer / agent-hub. Drift across
13 theme bundles is the primary risk this addresses.

All values are pre-computed by `bundleToPluginTokens()` in
`src/ui/renderer/theme/plugin-token-map.ts` using `color-mix(in srgb, …)`
expressions and shipped to plugin webviews as part of the `LvisHostThemeEvent`
token payload. Plugins reference them via `var(--lvis-primary-bg-subtle)` etc.

| Token | Semantic intent | Mix rule |
|-------|----------------|----------|
| `--lvis-primary-bg-subtle` | Tinted primary surface — card highlight, active row bg | `color-mix(primary 14%/18%, card)` (light/dark) |
| `--lvis-primary-bg-strong` | Stronger tint — hover/active variant of subtle | `color-mix(primary 28%/32%, card)` (light/dark) |
| `--lvis-danger-bg-subtle` | Tinted danger surface for inline alerts, error rows | `color-mix(destructive 14%, transparent)` |
| `--lvis-warning-bg-subtle` | Tinted warning surface for caution banners, status chips | `color-mix(warning 14%, transparent)` |
| `--lvis-success-bg-subtle` | Tinted success surface for status pills, done states | `color-mix(success 14%, transparent)` |
| `--lvis-surface-hover` | fg-over-secondary blend for hover highlights | `color-mix(fg 6%/10%, secondary)` (light/dark) |
| `--lvis-focus-shadow` | Box-shadow ring color for `focus-visible` outlines | `color-mix(ring 62%, transparent)` |

**high-contrast** bundle receives elevated mix percentages (24% subtle / 40%
strong / 14% hover) to meet WCAG AA+ contrast requirements on black backgrounds.

Follow-up migration PRs for meeting, local-indexer, and agent-hub will replace
their private color-mix derivations with these host-provided tokens.

**Box-shadow elevation tokens (follow-up):** `--lvis-elevation-shadow-soft` and
`--lvis-elevation-shadow-strong` (full `box-shadow` offset+blur+color values) are
intentionally deferred to a separate PR. Meeting plugin's `--pm-toggle-hover-shadow`
and `--pm-toggle-selected-shadow` remain as-is until that elevation family lands.
This keeps the current 7-token set's scope tight while documenting the gap.
