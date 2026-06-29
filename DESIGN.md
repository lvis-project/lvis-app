# Design

## Source of truth
- Status: Draft
- Last refreshed: 2026-06-30 (Asia/Seoul)
- Primary product surfaces: LVIS desktop renderer, chat workspace, action workspace, right-side tool activity panel.
- Evidence reviewed: `src/ui/renderer/components/ActionPanel.tsx`, `src/ui/renderer/components/ToolGroupCard.tsx`, `src/ui/renderer/components/OverlayCard.tsx`, `src/ui/renderer/theme/`, `docs/blueprints/composer-redesign-mockup.html`.

## Brand
- Personality: calm, technical, work-focused.
- Trust signals: visible state, compact operational metadata, stable layout that avoids covering active work.
- Avoid: marketing-style hero layouts, duplicate navigation, decorative panels, and full-height surfaces when a compact work widget is enough.

## Product goals
- Goals: keep the main chat usable while exposing recent tool activity; make file, MCP, plugin, tool, and web activity scannable at a glance.
- Non-goals: replace the primary sidebar, reproduce all historical activity, or add another full workspace navigator.
- Success signals: action-mode chat reads as a centered blog column; the floating panel shows counts when collapsed, shows details when expanded, and limits each detail list to the latest five items.

## Personas and jobs
- Primary personas: developers and agent operators using LVIS for iterative work.
- User jobs: monitor what the agent read, wrote, called through MCP/plugins/tools, and fetched without leaving the chat.
- Key contexts of use: long-running coding sessions, MCP/plugin work, and review of recent side effects.

## Information architecture
- Primary navigation: existing left sidebar remains the route/navigation owner.
- Core routes/screens: home chat, action/plugin surfaces, settings, marketplace, memory, routines.
- Content hierarchy: right action panel contains compact counts in collapsed state; expanded state adds a header and recent activity sections for files, MCP calls, and fetched pages.

## Design principles
- Principle 1: Preserve chat as the primary canvas; in action mode, use a centered reading column so the floating right panel sits in side whitespace rather than becoming a full layout column.
- Principle 2: Favor recent, high-signal operational facts over complete logs.
- Tradeoffs: compact rows reduce detail depth but keep the panel usable during active chat work.

## Visual language
- Color: reuse theme tokens such as `bg-card`, `bg-muted`, `text-muted-foreground`, `border-border`, and `text-primary`.
- Typography: small, dense labels and tabular counts; no viewport-scaled type.
- Spacing/layout rhythm: compact 8-12px internal rhythm with a bounded floating right panel and centered chat column.
- Shape/radius/elevation: 8-12px radius and restrained shadow for tool surfaces.
- Motion: keep existing transition patterns; avoid attention-heavy animation for passive monitoring.
- Imagery/iconography: use lucide icons for categories and open/close controls.

## Components
- Existing components to reuse: `Button`, `Tooltip`, existing theme tokens, lucide icons.
- New/changed components: `ActionPanel` as a floating right panel with compact activity sections.
- Variants and states: open detail panel, collapsed count dashboard, empty activity, running/done/error tool status.
- Token/component ownership: renderer components own layout; shared UI components own base controls.

## Accessibility
- Target standard: keyboard and screen-reader accessible desktop UI.
- Keyboard/focus behavior: open/close controls are buttons with labels and expanded state.
- Contrast/readability: rely on theme contrast tests and semantic foreground/background tokens.
- Screen-reader semantics: expose the panel as an `aside` with an accessible label.
- Reduced motion and sensory considerations: no required motion for understanding state.

## Responsive behavior
- Supported breakpoints/devices: desktop Electron windows with resizable width.
- Layout adaptations: open panel floats in the right side area; closed state keeps only a compact count dashboard.
- Touch/hover differences: hover is enhancement only; core actions remain clickable buttons.

## Interaction states
- Loading: running tools use status labels rather than skeletons.
- Empty: each category has a compact empty state.
- Error: failed tools use destructive status styling.
- Success: completed tools use success status styling.
- Disabled: inherited from shared button states.
- Offline/slow network, if applicable: fetched-page list remains empty unless web activity is observed.

## Content voice
- Tone: concise, operational, and literal.
- Terminology: use "read files", "written files", "MCP calls", "plugin calls", "tool calls", and "fetched web pages".
- Microcopy rules: avoid tutorial copy inside the panel; labels should identify data, not explain the feature.

## Implementation constraints
- Framework/styling system: React, TypeScript, Tailwind utility classes, existing LVIS UI components.
- Design-token constraints: no new palette or bespoke token layer for this panel.
- Performance constraints: derive activity from existing chat entries and cap rendered detail lists at five items per category.
- Compatibility constraints: keep existing smoke tests and renderer build passing.
- Test/screenshot expectations: smoke tests should verify panel presence, close/open behavior, no sidebar duplication, and tool activity sections.

## Open questions
- [ ] Decide whether future sessions need persisted activity history beyond the current chat stream.
