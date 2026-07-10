# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-06-30 (Asia/Seoul)
- Primary product surfaces: LVIS desktop renderer, chat workspace, work mode, plugin pages, settings, marketplace, right-side action/activity surfaces.
- Evidence reviewed:
  - External index: `https://github.com/voltagent/awesome-design-md`
  - Downloaded reference docs via `getdesign`: Linear, Raycast, Vercel, VoltAgent
  - Local token system: `src/styles.css`, `src/shared/theme-bundles.ts`, `src/ui/renderer/theme/`
  - Local component surfaces: `src/ui/renderer/components/ActionPanel.tsx`, `Sidebar.tsx`, `MainContent.tsx`, `InputActionBar.tsx`, plugin host pages
  - Local docs: `docs/development/theme-system.md`

## Brand
- Personality: calm, technical, high-agency, and work-focused.
- Product feel: an operator workbench, not a marketing page. The app should feel dense, clear, and stable under long-running agent work.
- Trust signals: visible state, accurate side-effect reporting, preserved position/context, restrained interaction feedback, and clear boundaries between navigation, work canvas, plugins, and settings.
- Avoid: decorative cards, nested boxes, one-note color palettes, gradient blobs, hero composition, oversized headings inside tool surfaces, and heavy shadows as the primary hierarchy tool.

## Product goals
- Give users a reliable desktop agent environment where chat, work mode, tools, plugins, settings, and local status can coexist without visual noise.
- Make side effects and system state legible: files read/written, plugin calls, MCP calls, model/mode, approvals, indexing, and permissions.
- Keep repeated workflows efficient: navigation must preserve context, controls must remain compact, and plugin pages must share one host-level layout grammar.
- Support localized UI as a first-class path, including Japanese and Chinese, without falling back to English for newly added product text.
- Make theme work predictable by routing colors, surfaces, focus, and motion through product tokens rather than component-local reinvention.

## Personas and jobs
- Primary personas: developers, AI-workflow operators, plugin builders, and reviewers using LVIS for iterative desktop work.
- User jobs:
  - Continue a task while understanding what the agent is doing.
  - Inspect plugin/system state without losing chat or scroll context.
  - Switch between chat and work modes without semantic ambiguity.
  - Configure model, provider, reasoning, approvals, language, and theme with minimal hunting.
  - Review recent side effects quickly during or after a run.

## Information architecture
- Primary navigation: left sidebar owns app-wide routes and plugin entry points.
- Primary canvas: route content owns the main work area. Page bodies should not be wrapped in extra decorative boxes when the page itself is already a surface.
- Top/page navigation: first-depth plugin or settings pages may expose a simple back control when leaving the current page should return to the previous route.
- Chat/work mode: mode controls are operational state, not navigation. Internal values and displayed labels must remain aligned.
- Secondary surfaces: action panels, popovers, command pickers, and inspectors float above the canvas only when they are temporary or auxiliary.

## Design principles
1. Product UI is the reference.
   - Use real app state and real product surfaces. Do not add abstract decoration to make a screen look designed.
2. Hierarchy comes from tokens and layout.
   - Prefer whitespace, hairlines, semantic surfaces, and restrained elevation. Avoid box-in-box layouts unless the inner box is a distinct repeated item, modal, or framed tool.
3. Accent color means work.
   - Reserve primary accent for active work, selected state, send/confirm actions, and important live state. Status colors remain literal: success, warning, destructive, info.
4. Motion acknowledges, it does not perform.
   - Motion should confirm state changes and help orientation. It should not distract from text, code, or tool output.
5. Token-first implementation.
   - New colors, shadows, focus rings, and motion values must enter through shared tokens when they represent reusable UI language.
6. Localization is a product requirement.
   - New user-facing strings must include generated catalog coverage and generated locale entries for supported languages.

## Visual language
- Color:
  - Components consume semantic tokens (`bg-card`, `text-foreground`, `border-border`, `text-primary`, etc.).
  - Theme bundles map semantic tokens to palettes. Components do not consume primitive palette values directly.
  - The new `executive-graphite` bundle is the reference restrained dark theme: warm graphite chrome, teal work accent, amber branch/caution accent, and limited secondary emphasis.
- Typography:
  - Use system UI text for renderer surfaces and monospace only for code, paths, commands, counters, and technical metadata.
  - Type scale (matches shipped de-facto usage — `text-xs` dominates dense surfaces):
    - `text-xs` (12px): default body inside dense panels, lists, metadata, and chrome.
    - `text-sm` (14px): comfortable body, control labels, dialog copy.
    - `text-base` (16px): lead paragraphs only; rare by design.
    - `text-lg` and above: page titles and section headers only — never inside repeated items.
  - No viewport-scaled type and no negative letter spacing in app UI.
  - Compact panels use compact headings; hero-scale type belongs only to real hero surfaces, which the app generally should not need.
- Spacing/layout rhythm:
  - Prefer dense 4/8/12/16px rhythm.
  - Toolbars and panels should have stable dimensions so counters, icons, hover states, and localized text do not resize the layout.
  - Page sections are full-width bands or unframed layouts with constrained inner content, not floating cards inside cards.
- Shape/radius/elevation:
  - Product cards stay at 8px radius or less unless an existing primitive requires otherwise.
  - Floating auxiliary surfaces may use 12px radius when they need clear separation.
  - Elevation uses `--surface-hairline`, `--elevation-raised`, and `--elevation-floating` rather than raw `shadow-xl`/`shadow-2xl`.
- Stacking (z-order ladder):
  - Canvas content stays at `z-0`–`z-30` (sticky headers/rails at `z-10`–`z-30`).
  - Docked auxiliary panels use `z-40`; all floating overlays (dialog, popover, command picker, tooltip, toast) share the `z-50` band and rely on portal/mount order within it.
  - Arbitrary escapes (`z-[9000]`-style) are drift, not a tier — fold the remaining outliers back into the ladder when touched.
- Motion:
  - Use `--motion-fast`, `--motion-base`, `--motion-slow`, `--motion-ease-out`, and `--motion-ease-standard`.
  - `prefers-reduced-motion` is authoritative.
- Imagery/iconography:
  - Use lucide icons for actions and categories when available.
  - Icon sizes (de-facto standard): 14px (`h-3.5 w-3.5`) is the default in dense chrome and buttons; 12px (`h-3 w-3`) inline beside captions/metadata; 16px (`h-4 w-4`) in comfortable rows and dialogs. Larger sizes are reserved for identity marks (plugin/app icons), not actions.
  - Avoid visible text where a familiar icon plus tooltip communicates the control more cleanly.
- Data display:
  - Numeric columns and counters use `tabular-nums` so digits align and layouts stay stable while values tick.
  - Truncation is intentional: single-line cells use `truncate`; multi-line summaries clamp at 1–2 lines (`line-clamp-1/2`). Paths and identifiers truncate with a tooltip carrying the full value; prefer keeping the tail (filename) visible.
  - Timestamps are compact and locale-aware; relative time may be used in activity feeds but absolute time must be recoverable (tooltip or detail).

## Components
- Existing components to reuse: shadcn primitives in `src/components/ui/*`, theme provider, semantic token utilities, lucide icons, existing tooltip/popover/dialog primitives.
- Canonical app surfaces:
  - Sidebar: route ownership and plugin entry points.
  - Main canvas: route-owned work surface with minimal host framing through `PageShell`.
  - ActionPanel: floating operational activity surface.
  - Command picker: search and 1st/2nd-depth command navigation.
  - Settings and plugin pages: dense product configuration surfaces using the same `PageShell` chrome.
  - PageSection: unframed settings/page bands for section grouping; do not wrap these bands in Card chrome.
- Variants and states:
  - Hover: subtle semantic surface tint, never layout shift.
  - Active/selected: primary or route-specific accent with accessible foreground.
  - Focus: shared ring token, always visible for keyboard users.
  - Empty/loading/error/success: literal operational state, not decorative copy.
- Token/component ownership:
  - Shared primitives own focus, disabled state, base radius, and control structure.
  - Feature components own domain layout and data density.
  - Theme bundles own palette choices, not component behavior.

## Plugin surfaces (shared guide for plugin authors)
Plugin UIs are **free**: the SDK ships no UI components, tokens, or style checks. This section is the philosophy and the small set of hard boundaries that keep a free plugin UI feeling native inside the workbench.

### What crosses the webview boundary today
- Plugin panels render in isolated webviews. The host provides **only the shared font stack** (`plugin-ui-shell.html`, mirroring `src/shared/host-font-stack.ts`). The app's semantic tokens (`bg-card` etc.), Tailwind setup, and theme bundles do **not** reach plugin webviews — bring your own styling.
- Host theme (light/dark) and UI language are **not yet signaled** across the boundary; both are open design items (see Open questions). Until then, choose a self-contained palette that holds up regardless of the host theme, and keep your strings externalized so a locale signal can be adopted later.

### Chrome ownership
- The host draws the page chrome: sidebar entry, `PageShell` title/back control for plugin pages, and panel framing. **Do not draw a second page title bar or back button inside your panel** — your surface starts inside the content area.
- Detached windows and side-panel docking are host decisions; the same panel markup must work in both.

### Mandatory / recommended / free
| Level | Items |
|---|---|
| **Mandatory** | Works at the 448px panel floor (mobile-class base; verify at 448/640/1024). No horizontal page scroll. Keyboard-reachable essential actions with visible focus. WCAG AA text contrast. `prefers-reduced-motion` respected. No second page chrome. |
| **Recommended** | The philosophy in this document: operator-workbench feel, dense 4/8/12/16 rhythm, restrained accent (accent = work/selection, status colors literal), compact type scale, icons+tooltips over label noise, literal operational copy. |
| **Free** | Layout, component library, visual identity inside the panel, iconography style, brand accents — anything not listed above. A plugin may look like itself. |

## Token System Assessment
- Decision: keep the existing semantic token and bundle registry architecture. It is structurally sound and already supports multi-theme contrast tests.
- Required improvement: evolve the system beyond color. The previous gap was elevation and motion, which caused local shadow/timing choices to drift across panels and plugin surfaces.
- Implemented direction:
  - Add product-wide motion tokens in `src/styles.css`.
  - Add surface/elevation tokens and utilities in `src/styles.css`.
  - Add `executive-graphite` as a reference-quality restrained theme bundle.
  - Update `docs/development/theme-system.md` so future work follows the new token contract.
- Not needed now:
  - Replacing the theme bundle model.
  - Adding a new design-token package.
  - Moving every spacing utility to CSS variables before a repeated semantic need exists.
- Future migration target:
  - Replace remaining raw `shadow-xl`/`shadow-2xl` in floating panels with `lvis-surface-*` utilities.
  - Continue replacing route-local page chrome with `PageShell`/`PageSection` when new top-level surfaces are added.

## Accessibility
- Target standard: keyboard and screen-reader accessible desktop UI with WCAG AA contrast for text and meaningful controls.
- Keyboard/focus behavior: every visible command must be reachable by keyboard and expose a clear focus state.
- Contrast/readability: theme contrast tests are required for every shipped bundle.
- Screen-reader semantics: panels use landmarks/labels when they carry independent meaning.
- Reduced motion: all nonessential motion must collapse to near-zero duration under reduced-motion preference.
- Localization: UI must remain stable for Japanese, Chinese, Korean, English, Spanish, French, and German strings.

## Responsive behavior

### Support boundary
- LVIS is a **desktop-only** product: the sole runtime is a resizable desktop Electron window. There are no phone or tablet builds, no touch-first target, and no separate mobile app planned.
- Even so, every surface is designed **responsively across window widths**, using tablet/mobile-class width tiers as design boundaries. This is not aspirational: the enforced floors already put real surfaces inside phone-class widths — the main window clamps at **460px** (`MAIN_WINDOW_MIN_WIDTH`, `src/main/main-window-bounds.ts`) and a plugin side panel renders at **448px** (`SIDE_PANEL_MIN_WIDTH`, `src/shared/side-panel.ts`). A surface that only works at laptop width is a defect, not a nice-to-have gap.

### Width tiers (the shared breakpoint system)
Tiers map 1:1 onto the Tailwind default scale already used across the renderer (`sm:`/`md:`/`lg:` — no custom overrides), so the design language and the implementation utilities never diverge:

| Tier | Window/pane width | Tailwind | What must hold |
|---|---|---|---|
| **Mobile-class** | `< 640px` (floor: 448/460px) | base (mobile-first) | The **mandatory baseline**. Single-column layout; primary navigation compacts; every essential action reachable; no horizontal scroll of the page body; floating panels clamp to the viewport. Plugin panels live here whenever docked as a side panel. |
| **Tablet-class** | `640–1023px` | `sm:` / `md:` | Two-pane layouts may appear (list + detail, chat + rail). Density increases; controls may gain labels that were icon-only at mobile-class. Typical for half-screen window snapping and narrow laptops. |
| **Desktop-class** | `≥ 1024px` | `lg:` | Full workbench: sidebar + canvas + right-side action/activity surfaces concurrently. Multi-column settings and wide tables are allowed only here. |

- **Author mobile-first**: style for the mobile-class base, then enhance upward with `sm:`/`md:`/`lg:`. Never author a desktop-only layout and patch it downward.
- Tier checks are on **container/window width**, not device detection — a desktop window dragged narrow IS the mobile-class experience.
- Plugin authors: treat **448px** as your panel's hard floor and design the panel's base layout for mobile-class; a plugin page promoted to the main canvas may assume tablet-class and up. Verify at 448px, 640px, and 1024px before shipping.

### Layout adaptations
- Primary navigation may compact, but it must not duplicate route ownership.
- Floating panels must clamp to viewport width and height.
- Text inside controls must wrap or truncate intentionally without overlapping adjacent controls.
- Wide content (tables, code, diagrams) scrolls inside its own container — the page body never scrolls horizontally.

### Touch/hover
- Hover is enhancement only; all essential actions remain click/keyboard accessible. Touch input is tolerated (hover-independent affordances), never a design target.

## Interaction states
- Loading: use compact progress or status text near the affected control.
- Empty: state what is empty, not how the feature works.
- Error: use destructive semantics and include the next actionable recovery when available.
- Success: use success semantics sparingly; avoid celebratory motion.
- Disabled: preserve legibility and explain disabled controls through tooltip or adjacent status only when the reason is not obvious.
- Offline/slow network: keep local app navigation responsive and isolate remote failure to the affected operation.
- Notification hierarchy (pick the narrowest surface that fits):
  - **Inline status** next to the affected control — the default for operation results.
  - **Toast** for transient confirmations of a user-initiated action (e.g. saved); auto-dismissing, never load-bearing.
  - **Banner** for persistent, page-scoped conditions that need action (e.g. update available); dismissible, stays until resolved.
  - **OS notification** only for events the user must see while the window is unfocused; always mirrored by in-app state.

## Content voice
- Tone: concise, operational, literal.
- Terminology:
  - Use "Work" for the former action mode, including internal values.
  - Use "Chat" for conversation-only mode.
  - Use "provider", "model", "reasoning", "approval", "plugin", "MCP", and "local indexer" consistently.
- Microcopy rules:
  - Do not add tutorial text inside normal app surfaces.
  - Labels identify the data or action.
  - Tooltips can explain icon-only controls or unavailable actions.

## Implementation constraints
- Framework/styling system: React, TypeScript, Tailwind v4 utilities, CSS variables in `src/styles.css`, existing shadcn primitives.
- Design-token constraints:
  - No component-local palette values for reusable UI language.
  - No raw heavy shadow utilities for new floating surfaces when `lvis-surface-*` applies.
  - No new dependency for design tokens without a concrete migration need.
- Performance constraints:
  - Theme switching must remain runtime CSS-variable based.
  - Repeated panels should cap rendered detail lists and avoid layout reflow from dynamic counters.
- Compatibility constraints:
  - Keep Electron renderer build, theme bundle tests, contrast tests, and i18n parity tests passing.
- Test/screenshot expectations:
  - Theme changes require bundle invariant tests and contrast coverage.
  - Layout changes require targeted component/e2e smoke or visual inspection when practical.

## Open questions
- Should typography scale tokens be promoted once Japanese/Chinese visual QA identifies repeated density adjustments?
- Plugin webview theme signal: should the host inject a minimal semantic-variable set (or a light/dark signal) into plugin webviews so free-form plugin UIs can follow the host theme? Design pending — today plugins receive only the font stack.
- Plugin locale signal (i18n wiring): plugins should be able to FOLLOW the host UI language (strings externalized; no language is mandated), but no locale getter/change signal crosses the runtime or webview boundary yet. Wiring design pending; reviewed 2026-07-10.
