# LVIS Docs — Design System

> The visual language for **docs.lvisai.xyz**, derived from the LVIS Marketplace
> (`marketplace.lvisai.xyz`) as the structural foundation and refined with premium
> cues from Google **Antigravity** (`antigravity.google`).
>
> **North star:** _restraint over decoration_. A calm, near‑monochrome, system‑font
> surface where typography and whitespace — not color — carry the hierarchy.

---

## 1. Sources & how they combine

| Reference | Role | What we take |
|---|---|---|
| **Marketplace** (`marketplace.lvisai.xyz`) | **Foundation** | Neutral off‑white canvas, near‑black ink, system font, subtle hairline borders, white cards, understated hover, tight tracking on bold headings, generous whitespace. |
| **Antigravity** (`antigravity.google`) | **Refinement** | Larger, *lighter‑weight* display type; full‑pill primary buttons; circular monochrome icon chips; a single soft periwinkle gradient glow as the only ambient color; airy, calm spacing; quiet motion. |

The result is **marketplace‑neutral with an antigravity finish**: the docs read as
a quiet, professional product surface, with one soft cool‑blue glow reserved for hero
moments. Brand color (the old teal / citron / coral) is retired from the interface.

### Measured reference tokens

Captured live from the two sites (computed styles), for provenance:

**Marketplace**
- Page background `#fafafa` · cards `#ffffff`
- Heading ink `oklch(0.205 0 0)` ≈ `#1c1c1c` · body `#000`
- Muted text `oklch(0.556 0 0)` ≈ `#737373`
- Hairline border `oklch(0.922 0 0)` ≈ `#e5e5e5`
- Font: `system-ui, -apple-system, "Segoe UI", Roboto`
- `h1` `20px/700` tracking `-0.5px` · hero `h2` `30px/700` tracking `-0.75px`
- Outline button: white, `1px` border, radius `6px`, `14px/500`, `padding 0 12px`
- Tabs: underline, active = `2px` solid ink bottom border

**Antigravity**
- Ink `#121317` · muted nav link `#45474d`
- Font: `Google Sans Flex` (variable), display **weight 450**, `h1` `80px/88px`, `h2` `42px` tracking `-0.73px`
- Primary CTA: `bg #121317`, white, `border-radius: 9999px` (pill), `padding 10px 24px`, weight `450`
- Icon chips: circle, translucent periwinkle fill `rgba(183,191,217,0.09)`, hairline `rgba(33,34,38,0.06)`
- Ambient accent: soft periwinkle / cool‑blue gradient glow

---

## 2. Principles

1. **Monochrome first.** Color is not a hierarchy tool. Rank things with size, weight,
   spacing, and border — not hue.
2. **One accent, used sparingly.** A soft periwinkle glow (`--glow`) appears only as an
   ambient hero backdrop. It never colors text, borders, or interactive states.
3. **Ink is the brand.** Primary buttons, active states, and emphasis are near‑black ink.
4. **Hairlines, not shadows.** Structure comes from `1px` neutral borders; elevation is a
   whisper (`shadow-sm`), lifting to `shadow-md` only on hover.
5. **Airy.** Sections breathe. Prefer more vertical rhythm than feels necessary.
6. **Quiet motion.** 150–320ms ease‑out; a 0.5–2px lift or fade. Nothing bounces.

---

## 3. Color

### 3.1 Foundation (cool neutral)

A neutral gray with a faint cool undertone — echoing antigravity's `#121317` ink and
periwinkle glow, while reading as marketplace‑neutral.

| Token | Hex | Use |
|---|---|---|
| `bg` / `--background` | `#fafafa` | Page canvas |
| `surface` / card | `#ffffff` | Cards, header, popovers |
| `secondary` | `#f3f4f6` | Subtle fills, hover backgrounds, code chips |
| `border` | `#e6e7ec` | Hairline dividers, card borders |
| `border-strong` | `#d6d8df` | Emphasized dividers |
| `muted-foreground` | `#676b76` | Secondary / body‑dim text |
| `ink` | `#14161d` | Primary text, primary buttons, active states |
| `ink-soft` | `#3a3d47` | Eyebrows, labels, hover‑darken |

### 3.2 Accent — the single glow

| Token | Value | Use |
|---|---|---|
| `glow` | `#c3ccdf` (periwinkle) | Hero ambient radial glow **only** |
| `glow-tint` | `rgba(183,191,217,0.09)` | Circular icon‑chip fill (antigravity chip) |

> There is intentionally **no saturated text/link accent.** Links are ink with an
> underline affordance. If brand continuity is later required, the LVIS teal
> (`#007c72`) can be re‑introduced as `accent` for links/focus only — but the default
> system is monochrome by design.

**Semantic status (the one exception).** Warnings and errors keep a functional color so
they can't be missed: `amber` for `warn` callouts, `destructive` red for danger. This is
status signal, not decoration — everything else stays monochrome.

### 3.3 Legacy alias remap (implementation)

The old brand tokens are **kept as aliases** so existing class names across the 41 routes
keep working, but they now resolve to neutral values. Prefer `ink` / `secondary` /
`muted-foreground` / `glow` in new code.

| Legacy token | Was | Now resolves to |
|---|---|---|
| `teal` / `teal-dark` / `teal-600/700` | brand green `#007c72` | ink scale (`#3a3d47` → `#14161d`) |
| `citron` / `citron-soft` | lime `#d6f36b` | soft periwinkle chip (`#e7eaf2` / `#eef0f6`) |
| `coral` | orange `#ff7a5c` | muted neutral (`#7a7f8a`) |

Effect: `text-teal` eyebrows become refined dark‑gray, `bg-teal` buttons become ink,
`bg-citron/30` glows become soft periwinkle, `text-coral` dots become muted gray — the
whole surface neutralizes without touching page markup.

---

## 4. Typography

### 4.1 Family

System‑first, matching the marketplace, with Korean coverage. No web‑font download.

```
--font-sans: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont,
             "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR",
             system-ui, sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
```

### 4.2 Scale & weights

Antigravity's move — **large but light** — softened for a docs surface. Display type is
**semibold (600)**, not black; body is regular (400). Tracking tightens as size grows.

| Role | Size | Weight | Tracking | Line‑height |
|---|---|---|---|---|
| Hero display | `44 → 56px` (`clamp`) | 600 | `-0.022em` | `1.05` |
| Page `h1` | `30 → 36px` | 600 | `-0.02em` | `1.1` |
| Section `h2` | `24px` | 600 | `-0.015em` | `1.2` |
| `h3` | `18px` | 600 | `-0.01em` | `1.35` |
| Body | `15.5px` | 400 | normal | `1.78` |
| Small / meta | `12.5–13px` | 500 | normal | `1.5` |
| Eyebrow / label | `11px` | 700 | `0.16em` uppercase | — |

Eyebrows are `ink-soft` (or `muted-foreground`), **not** colored.

---

## 5. Layout & spacing

- **Content column** max `1400px` shell; docs body max `760px`; marketing/landing
  sections max `1152px` (`max-w-6xl`).
- **Gutters:** `px-4` mobile → `px-6` desktop.
- **Section rhythm:** `56–72px` between major sections (`mb-14`/`mb-16`). Hero → first
  section gets the larger gap.
- **Grid:** feature/card grids `gap-3`; 2–3 columns responsive.

---

## 6. Radius & elevation

| Token | Value | Use |
|---|---|---|
| `--radius` | `0.625rem` (10px) | Cards, inputs, popovers (`lg`) |
| `md` | `8px` | Inner elements |
| `sm` | `6px` | Small controls, code chips |
| **pill** | `9999px` | Primary/large buttons, chips (antigravity) |

Elevation: `shadow-sm` at rest, `shadow-md` on hover. No colored shadows.

---

## 7. Components

### Buttons
- **default / primary** → `bg-ink text-white`, **pill** (`rounded-full`), `hover:bg-ink-soft`.
- **outline** → white, `1px border`, `text-ink`, `hover:bg-secondary`, pill.
- **ghost** → `text-ink`, `hover:bg-secondary`.
- **link** → `text-ink`, `underline-offset-4 hover:underline`.
- Sizes: `sm h-8` (radius `md`), `default h-10`, `lg h-11`. `default`/`lg` are pills;
  `icon`/`sm` stay `rounded-md`.
- Weight `500–600`, no letter‑spacing, `gap-2` for trailing icons.

### Badges / chips
- Pill, `11px`, uppercase, `tracking-wide`, `font-semibold`.
- `default` → `bg-ink text-white` · `muted` → `bg-secondary text-muted-foreground` ·
  `outline` → `border text-ink`. Color variants map to neutral fills.
- **Icon chip** (antigravity): circle `36–48px`, `bg-glow-tint`, hairline border,
  monochrome line icon (`lucide`), no shadow.

### Cards
- `bg-white`, `1px border`, radius `lg`, `shadow-sm`. Hover: `border-strong` +
  `shadow-md` + `-translate-y-0.5`. Padding `p-5`. Titles `ink` semibold; descriptions
  `muted-foreground`.

### Header
- Sticky, `bg-white/82 backdrop-blur-md`, hairline bottom border, `h-14`.
- Logo: `ink` rounded square mark + wordmark. Nav links `muted-foreground` →
  `hover:text-ink`. Primary CTA = ink **pill**.

### Sidebar
- Group labels: `ink` semibold; eyebrows `muted-foreground` uppercase.
- Item rest: `muted-foreground`; hover `bg-secondary text-ink`.
- **Active:** `bg-secondary text-ink font-semibold` (neutral, echoing the marketplace's
  black active tab) — no colored fill.

### Hero
- White rounded panel, hairline border. Ambient: **one** soft periwinkle radial
  `glow` blur (top‑right) + a very faint grid. No multi‑color blobs.
- Display heading in ink (no colored span). CTAs: ink pill + outline pill.
- Meta dots: neutral (`ink` / `muted-foreground`), not red/green/lime.

### Prose (`.prose-doc`)
- Body `muted-foreground`; headings `ink`. Links `ink` `hover:underline`.
- `code` → `bg-secondary` rounded `sm`. Blockquote → `border-l` neutral + `bg-secondary/50`.

---

## 8. Motion

- Fades/lifts: `200–320ms ease-out`, ≤2px travel or opacity only.
- Hover transitions: `150ms`.
- Respect `prefers-reduced-motion` (disable transforms).

---

## 9. Implementation map

| Concern | File |
|---|---|
| Color tokens, radius, font, alias remap | `tailwind.config.ts` |
| CSS vars, prose, selection, glow, grid | `app/globals.css` |
| Button variants (pill, neutral) | `components/ui/button.tsx` |
| Badge variants (neutral) | `components/ui/badge.tsx` |
| Header CTA / nav | `components/docs/header.tsx` |
| Sidebar active state | `components/docs/sidebar.tsx` |
| Page hero eyebrow | `components/docs/page-hero.tsx` |
| Feature tones → neutral | `components/docs/feature-grid.tsx` |
| Landing hero glow / CTAs | `app/page.tsx` |

All other routes inherit the new look automatically through the token remap.

---

# v2 — Layout & Motion (Antigravity-level)

> v1 fixed the *palette*. v2 rebuilds the *experience*: an immersive, cinematic shell
> with real motion, treating the old layout as disposable and keeping only the content.
> Inspiration: `antigravity.google` — full‑bleed hero with an animated backdrop, huge
> light display type, floating monochrome icon chips, soft drifting glows, scroll‑reveal
> pacing, pill nav. Applied to a docs product without sacrificing findability or reading.

## 10. Two layout modes

The shell decides layout from the route (a client `AppFrame` reads `usePathname`):

- **Immersive** (`/` and future landing routes): **full‑bleed, no sidebar**. Cinematic
  hero, marketing‑grade sections, own rhythm. The home breaks out of the reading column.
- **Reading** (all doc routes): a refined 3‑column shell — floating glass header, a
  quieter sidebar with a **sliding active indicator**, a generous content column
  (`~820px`), and a right **TOC rail with a scroll‑progress line**.

Global chrome shared by both: a top **scroll‑progress bar**, a fixed **ambient backdrop**
(whisper‑faint aurora + grid), the glass header, and a spacious footer.

## 11. Motion system

Primitives (all `prefers-reduced-motion`‑aware — reduce to opacity‑only or none):

| Primitive | Behavior | Use |
|---|---|---|
| `Reveal` | fade `0→1` + rise `12–16px→0`, `450–650ms` ease‑out, once, via IntersectionObserver | section/blocks entering viewport |
| `Reveal` `delay` | staggered start (`60–90ms` steps) | lists of cards/chips |
| `ScrollProgress` | 2px top bar filling `0→100%` of scroll | global reading feedback |
| `HeroBackdrop` | 2–3 periwinkle/lavender radial glows drifting on `18–26s` loops + slow‑panning grid | immersive hero only |
| `float` | gentle bob `±6px` on `6–9s` ease‑in‑out loops (varied per index) | floating icon chips |
| hover lift | `-2 to -3px` + border darken + `shadow-md`, `180ms` | cards, chips |

Timing: entrances `450–650ms`, hovers `150–200ms`, ambient loops `6–26s`. Easing
`cubic-bezier(.22,.61,.36,1)` (ease‑out‑quint feel). Nothing bounces or spins.

## 12. Immersive hero (home)

- Full‑bleed, `min-h ~88vh`, centered or left‑weighted composition.
- **Animated backdrop**: drifting periwinkle/lavender/sky glows (desaturated, low‑opacity)
  over a slow‑panning faint grid. Calm, breathing — not flashy.
- **Display headline**: `clamp(44px, 7.5vw, 76px)`, weight **600**, tracking `-0.03em`,
  line‑height `1.02`. One ink color, no rainbow.
- **Floating icon‑chip row**: circular monochrome chips (`icon-chip`) bobbing on varied
  loops — the antigravity capability motif.
- CTAs: ink **pill** + ghost. Meta stats as quiet mono dots.
- Sub‑hero: a marquee/row of "what's inside" chips or a bento peek.

## 13. Sections (home)

- Generous vertical rhythm (`py-24 → py-32`), max content `~1120px`, full‑bleed glows.
- **Bento grid**: mixed‑size cards (one large + several small), each with an icon chip,
  hairline border, hover lift, `Reveal` stagger. Replaces the flat feature grid.
- **Alternating feature rows**: text ↔ mockup, revealing on scroll.
- **Stepped tour**: numbered, connected, revealing sequentially.
- Big footer: wordmark, grouped links, subtle top glow.

## 14. Reading shell (doc pages)

- **Header (glass, floating):** wordmark + section nav + prominent `⌘K` search pill +
  ink pill CTA. Gains a hairline + faint shadow only after scroll.
- **Sidebar:** group eyebrow (muted) + title (ink); items quiet; **active = filled pill**
  (`bg-secondary`, ink) with a small leading accent bar; hover = soft fill. `NEW`/tag
  badges as tiny neutral/periwinkle chips.
- **Content column:** `max-w-[820px]`, `text-[15.5px]/1.8`; headings gain a hover‑reveal
  `#` anchor; first block reveals on load, subsequent blocks on scroll.
- **TOC rail:** right, sticky, a vertical track with a filled progress segment marking the
  active heading; items muted → ink on active.
- **Prev/Next:** large pill cards at page end.

## 15. Implementation map (v2)

| Concern | File |
|---|---|
| Layout mode switch | `components/docs/app-frame.tsx` (client, `usePathname`) |
| Reveal / stagger | `components/motion/reveal.tsx` |
| Scroll progress | `components/motion/scroll-progress.tsx` |
| Animated hero backdrop | `components/motion/hero-backdrop.tsx` |
| Global chrome, ambient bg, footer | `app/layout.tsx` |
| Glass scroll‑aware header | `components/docs/header.tsx` |
| Sidebar sliding active | `components/docs/sidebar.tsx` |
| TOC progress rail | `components/docs/toc.tsx` |
| Keyframes / motion utilities | `app/globals.css`, `tailwind.config.ts` |
| Immersive home | `app/page.tsx` |
| Content chrome (reveal, anchors) | `components/docs/page-hero.tsx` + shared blocks |

---

# v3 — Quiet unification (single site)

> The landing (lvisai.xyz) and the docs are now **one Next.js app**: marketing landing
> at `/`, the guide under `/docs/*`. With the merge, the whole surface converges harder
> on the **marketplace's stark minimalism** — v2's antigravity flourishes are retired.

## Rules (supersede v2 where they conflict)

1. **One static glow, max.** The hero may keep a single non-animated periwinkle radial
   (`rgba(183,191,217,≤0.35)` before blur). No drifting/panning/aurora loops.
2. **No floating elements.** `animate-float` chips and marquee motion are gone; the
   `icon-chip` motif survives only as a static icon container.
3. **Heroes are content-height.** No `min-h-[Nvh]` heroes; vertical presence comes from
   `py-20`–`py-24`, not viewport locking. Display type caps at `clamp(…, 3.5–4rem)`.
4. **Reveal stays, quieter.** `.reveal` = 10px rise / 400ms, once. Scroll-progress bar
   and glass header remain (they're wayfinding, not decoration).
5. **No fixed page ambience.** The `.page-ambient` layer is removed; the canvas is flat
   `#fafafb`.
6. **Landing = same system.** The marketing page uses the identical tokens/components as
   the docs — cards, pills, icon chips, Reveal — with at most the one hero glow.

## Route split

| Route | Mode | Notes |
|---|---|---|
| `/` | Immersive (no sidebar) | Marketing landing — 8 ported sections |
| `/docs/` | Reading shell | Docs index (ex-docs-home, compacted) |
| `/docs/**` | Reading shell | 46 guide routes |

`docs.lvisai.xyz` 301-redirects here (`infra/docs-redirect/`).

### v3.1 — White canvas & one header (feedback round)

- **Canvas is pure white** (`--background: 0 0% 100%`). The gray-ish `#fafafb` read
  as dull next to antigravity — structure now comes from hairlines + whitespace only.
  `secondary` remains for small fills (chips, code, step numbers), never page areas.
- **One header, everywhere.** The same five items (하루 일과 · 다운로드 · 아키텍처 ·
  로드맵 · 문서) on landing and docs — landing sections via absolute `/#` anchors,
  문서 gets the active pill under `/docs/*`. Docs-internal nav lives in the sidebar
  and ⌘K only. No `/ docs` logo suffix, no nav personality switch.
- **Workday = pinned stage.** Desktop locks the viewport while scroll advances the
  eight moments (left rail, right crossfading stage, 500ms ease-out). Mobile,
  reduced-motion, and no-JS get the stacked list (SSR default).
- **Downloads = OS tabs.** Segmented control auto-selected by platform detection;
  one platform at a time with a CTA card + full-width vertical setup steps.
