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
  `--success`, …) live inside `[data-theme="<id>"]` blocks. Each variant
  re-points its semantic tokens to a different set of primitives.
- **Components** consume semantic tokens **only**, via Tailwind utilities
  defined in `tailwind.config.cjs` (`bg-background`, `text-primary`,
  `border-border`, etc.). They never read `--p-*` directly.

The Tailwind utilities resolve at build time to `hsl(var(--background))`,
which means runtime CSS-variable swaps re-paint immediately without a
rebuild.

---

## 2. Theme variants shipped

| `data-theme=` | When it applies                                              |
|---------------|--------------------------------------------------------------|
| `dark`        | Default. App default + the historical look.                  |
| `light`       | User opt-in. Bright surfaces, dark text.                     |
| `high-contrast` | Accessibility — pure black/white + saturated yellow accent. |

The user picks via Settings → 테마. The `system` choice is **not** a theme
in itself; it resolves at runtime to either `light` or `dark` based on
`prefers-color-scheme`, and the renderer follows OS changes live.

---

## 3. Provider + persistence

```
~/.lvis/settings.json
  └─ appearance.theme   ←── persisted preference (string)
                                  │
                                  ▼
              ThemeProvider  (src/ui/renderer/theme/)
                                  │  resolves "system" → "light"|"dark"
                                  ▼
              <html data-theme="…" class="lvis-theme-…">
                                  │
                                  ▼
                  [data-theme] block in styles.css
```

- `<ThemeProvider api={api}>` is mounted at the App composition root
  (`src/ui/renderer/App.tsx`).
- It calls `api.getSettings()` once on mount and applies the persisted
  preference. Failure to read settings is **not** fatal — the app boots
  with `system` as the implicit default.
- `setPreference()` writes `data-theme` immediately and calls
  `api.updateSettings({ appearance: { theme } })` in the background.
- When the active preference is `system`, the provider listens to
  `matchMedia("(prefers-color-scheme: light)")` so OS-level toggles flow
  through with no reload.
- Test escape hatch: `useOptionalTheme()` returns `null` instead of
  throwing when no provider is mounted (Storybook / isolated snapshots).

---

## 4. Adding a new semantic token

Use case: "I need a `info-banner` color separate from `primary`."

1. Pick the semantic name. Use *meaning*, not appearance — `info`, not
   `cyan`. Two foreground/background pairs is the typical shape.
2. Add the variable to **every** `[data-theme="…"]` block in
   `src/styles.css`, pointing at an existing primitive (or add a new
   primitive if no existing one fits):

   ```css
   :root, :root[data-theme="dark"] {
     /* existing tokens … */
     --info: var(--p-blue-400);
     --info-foreground: var(--p-slate-950);
   }
   :root[data-theme="light"] { --info: var(--p-blue-600); --info-foreground: var(--p-slate-50); }
   :root[data-theme="high-contrast"] { --info: 200 100% 60%; --info-foreground: 0 0% 0%; }
   ```

3. Expose it in `tailwind.config.cjs`:

   ```js
   info: { DEFAULT: "hsl(var(--info))", foreground: "hsl(var(--info-foreground))" },
   ```

4. Components can now use `bg-info text-info-foreground`.

The PR diff is CSS + 1 line of config. No component changes.

---

## 5. Adding a new theme variant

Use case: "I want a 'sepia' variant for night reading."

1. Add the literal to the `ThemePreference` union in
   `src/data/settings-store.ts` and the `VALID_THEMES` constant.
2. Mirror the union in `src/ui/renderer/theme/types.ts` and append the
   id to `THEME_PREFERENCES`.
3. Add a `[data-theme="sepia"]` block in `src/styles.css` that remaps every
   semantic token. Copy from `[data-theme="light"]` and tune.
4. Add an entry to the `OPTIONS` array in
   `src/ui/renderer/tabs/AppearanceTab.tsx`.
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

## 8. Out of scope (handled separately)

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

## 9. References

- `src/styles.css` — token definitions
- `src/ui/renderer/theme/ThemeProvider.tsx` — provider + matchMedia hook
- `src/ui/renderer/theme/resolve-theme.ts` — `system` → concrete resolver
- `src/ui/renderer/tabs/AppearanceTab.tsx` — settings UI
- `src/ui/renderer/__tests__/theme-provider.test.tsx` — provider tests
- `src/ui/renderer/__tests__/appearance-tab.test.tsx` — settings UI tests
