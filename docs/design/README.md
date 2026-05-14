# Design Mockups

Self-contained HTML mockups that captured the **design intent** for shipped UX
features. They are kept in-tree so the visual reasoning, alternatives
considered, and copy/spacing/color choices remain reviewable after the code
ships and the original chat thread is gone.

These files are static — open them directly in a browser. They have no build
step and no dependency on the app.

| File | Feature | Shipped in |
|------|---------|------------|
| [`chat-continuous-v3.html`](./chat-continuous-v3.html) | Continuous chat / Kakao-style stream / invisible auto-checkpoint / 3-tier rotation. Reference systems: Warp Agent topic-shift, OpenCode auto-compact, GitHub Copilot Checkpoints. | Absorbed into ChatView; StackedChatView removed (PR #549, closes issue #547) |
| [`plugin-grid-v3.html`](./plugin-grid-v3.html) | 5×2 plugin grid in the input action bar — monochrome line icons, install overlay, marketplace link. | PR #437 |
| [`composer-attachments.html`](./composer-attachments.html) | Multimodal composer — image/file drag-drop, clipboard paste, marker tokens (`[Image #N]`, `[File #N]`, `[Pasted text #N +M lines]`), `composeOutgoing()` contract. | PR #440 |
| [`ask-user-question-card.html`](./ask-user-question-card.html) | `ask_user_question` LLM tool inline card — single-question form / 2–4 paginated multi-question / urgent variant / confirm-review step / `dismissed:true` fallback. Recommend + 대안 badges, single-line free-text. | PR #334 (initial floating panel) → inlined into chat stream by `AskUserQuestionCard` (current production) |
| [`agent-hub-work-board-v1.html`](./agent-hub-work-board-v1.html) | Agent Hub Plugin UI detached-window storyboard — scenario states from plugin entry/login waiting/callback sync to My Work, Team Board, and exception/empty states. | Design review / not shipped |
| [`settings-controls-shadcn.html`](./settings-controls-shadcn.html) | Settings control primitive baseline — shadcn registry-backed Select, Checkbox, Switch, RadioGroup, Slider, NativeSelect, Field/Label visual contract. | PR #708 |

## When to update vs add a new file

- **Update in place** when the mockup still represents the design intent and
  only minor copy/spacing changed.
- **Add a new versioned file** (`*-v4.html`, `*-v5.html`) when the design
  pivots — keeping the old file lets future readers see why we moved.

Do not delete an old version once the corresponding feature shipped. The
mockup is the design record.
