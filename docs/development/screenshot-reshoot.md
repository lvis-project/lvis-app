# Screenshot re-shoot worklist

The images under `web/public/screenshots/` are published to the public docs
site. They were captured by hand from a live working session — `web/scripts/copy-screenshots.sh`
maps a folder of manual desktop captures onto the site's ASCII slugs — so a
number of them carry content that was never meant to leave the machine.

This document is the worklist for replacing them. It is not a deletion plan.
Images stay where they are until a replacement exists, so the docs pages never
point at nothing. Consent from the people who appear in the current images is
settled; that is why this is a scheduled re-shoot and not an incident.

**This file is published in a public repository. Describe what has to change,
never the content itself.** "The signature block carries a direct phone number —
retake with a seeded demo identity" is the right level. Reproducing the number,
the name, the host, or the meeting key is not, and undoes the point of the
exercise.

## Scope and counts

71 tracked images, all inspected individually.

| Verdict | Count | Meaning |
| --- | --- | --- |
| `reshoot` | 7 | Must be re-captured. Redaction cannot fix it, or would destroy what the image is there to show. |
| `redact` | 3 | One contiguous region carries the problem and is not the subject of the shot. |
| `keep` | 20 | Nothing on screen identifies a third party or exposes a credential. |
| `superseded` | 17 | The internal-portal plugin page and its images are removed by the in-flight de-identification change. No capture work here. |
| `replaced` | 24 | Re-captured from seeded data by the harness. |

Twenty-four images have been replaced with seeded captures so far, and the
ratchet now stands at **9**. Seventeen of the twenty-four moved it:
`plugin-permission-grant`, the six `work-assistant-*` cards, the four `meeting-*`
panel images, the three third-party `local-indexer-*` panel images, and the three
`local-indexer-search*` answers. Between them they carried the worst of the
backlog — two work addresses, a
colleague's name, grade and full organisational path, two base64 calendar
identifiers from which a mailbox identifier is recoverable, a live conference
join link printed alongside its password and host key, a verbatim
speaker-attributed transcript of a real meeting, an internal work-document
tree printed across a folder row, a progress line and a document list, and a full
network path naming a file-server host, an administrative share and an
individual's account. The other seven replacements were `keep` rows, and
replacing a `keep` row leaves the backlog count alone by construction (the
ratchet counts `third-party` entries only). Those seven were still worth
replacing: two of them printed the publisher's own home directory across several
fields, `local-indexer-home` printed a real indexed folder, and all seven now
come from the harness rather than from a working session.

`web/screenshot-provenance.json` is the machine-readable form of the same table,
and the gate described at the end of this document reads it.

## Reading a verdict

A `reshoot` row names the state the replacement has to be in, the identity it
has to be captured under, and what must not be in frame. A `redact` row names
the region and says why masking is genuinely enough there. Where the reasoning
below disagrees with the earlier triage pass, the row says so and why.

## The identity overlay, and why it defeats redaction

Some captures taken on a managed workstation carry a diagonal alphanumeric
overlay drawn across the entire frame. It sits a few luminance levels away from
the background, which makes it close to invisible at normal viewing and easy to
miss when triaging thumbnails.

Every image in this set was amplification-checked. The overlay is confirmed on
exactly three: `outlook-login-trigger.png`, `outlook-login-window.png` and
`outlook-login-after.png`. A first, coarser pass also suspected it on
`plugin-permission-grant.png` and `meeting-minutes.png`; a tighter check against
flat regions of those two showed the texture was gradient banding and desktop
wallpaper, not a stamp. Both are recorded here as clean of the overlay — each
was listed for its content, not for this. `plugin-permission-grant.png` has
since been replaced by a harness capture.

Two properties matter for the verdicts:

- **It is drawn over the content, not beside it.** On at least one image the
  string crosses the middle of the answer text the screenshot exists to show.
  Masking the overlay means masking the subject.
- **It differs between captures taken minutes apart.** The trailing characters
  change from one frame to the next while the leading group stays fixed, which
  is the signature of a per-session value rather than a static label. Treat it
  as identifying.

There is no blur, crop, or box that removes it while leaving a usable image. Only
re-capturing on a machine that does not apply it does.

**It is not predictable from the machine alone.** Captures from the same session
and the same workstation, minutes apart, differ in whether they carry it. So a
capture cannot be assumed clean because a sibling capture was clean.

### Checking a candidate image for it

Amplify the high-pass residual; the overlay appears, real UI text washes out:

```python
import numpy as np
from PIL import Image, ImageFilter

im  = Image.open("candidate.png").convert("L")
a   = np.asarray(im, dtype=np.int16)
med = np.asarray(im.filter(ImageFilter.MedianFilter(5)), dtype=np.int16)
v   = np.clip(np.abs(a - med), 0, 10) / 10.0
Image.fromarray((255 - v * 255).astype(np.uint8)).save("candidate-amplified.png")
```

Open the output and look for repeating diagonal strokes or a legible diagonal
string. Smooth curved bands are the desktop wallpaper, not an overlay. Run this
on every replacement before recording `"overlayChecked": true` in the manifest.

## Capturing without real data

### What exists today

`test/screenshots/` is a Playwright + Electron capture harness, keyed by the
exact same strings as `shots` in `web/lib/screenshots.ts`. It launches the host
app against an **isolated profile** with seeded settings and secrets, side-loads
the real built plugin bundles, kills animations for deterministic frames, and
writes to `test/screenshots/out/<key>.png`.

```bash
node scripts/capture-screenshots.mjs                    # full matrix
node scripts/capture-screenshots.mjs --grep meeting-upcoming
```

So a re-shoot pipeline exists and does not need to be invented. What it does not
yet have is coverage.

### What it covers, and what it does not

`test/screenshots/matrix.ts` holds 37 entries, one of which (`_smoke-settings-llm`)
is not a docs-site key. Of the remaining 36, **25 capture end-to-end today**:
`chat-app-update`, `chat-question-card`, `chat-todo-queue`, `chat-tool-thinking`,
`chat-permission-directory`, `chat-permission-risk`, `chat-permission-llm-review`,
`plugin-permission-grant`, `meeting-upcoming`, the three `meeting-minutes*` keys,
the six `work-assistant-*` keys, the four `local-indexer-*` panel keys, and the
three `local-indexer-search*` answers. The rest carry an explicit `skip` with a
stated blocker. Those blockers are real, not missing effort:

| Blocked group | Blocker |
| --- | --- |
| `chat-plugin-panel` | The plugin whose panel this key shows does not load in the isolated profile: its bundle's factory spawns a confined child before the ASRT sandbox is active there, so the runtime tears the plugin down. Recorded as reproducing on an unmodified checkout, so it is not caused by this change. |
| `meeting-*` recorder / mail (4) | `meeting-record` and `meeting-record-stt` need a live microphone and a completed transcription; `meeting-outlook-mail*` needs an authorised mailbox. The `<webview>` is no longer part of this blocker — see `waitInPluginGuest`. |
| `outlook-*` (4) | The manifest declares a login tool, so selecting the panel goes straight to a live authorisation window. |
| `agent-hub-*` (2) | No such plugin bundle exists in the workspace. |

Every `local-indexer-*` key — the four panel ones and the three answers — carries
one further precondition that is a machine property rather than a code one:
`LVIS_SCREENSHOT_REAL_PYTHON=1` reuses a venv the host already built (no network,
no compile), so a venv for this plugin's exact requirements lock has to exist
under the real `~/.lvis/runtime/python-envs/` before any of them can capture.
Without the flag they skip with that reason. The port precondition these rows
used to carry is gone: `workerPort` is a real setting now, `capturePluginConfigs`
hands each run a free one, and two LVIS instances no longer fight over 43129.

`meeting-upcoming` and the three `meeting-minutes*` keys capture the real plugin
panel over a fabricated corpus written straight into the plugin's own stores —
one prep in `preps.json`, one finalised session under `sessions/`. Both were
previously recorded as blocked, and both blockers were wrong; see item 4 below.

The `mp-*`, `ah-*` and internal-portal keys are web/server screens from a
separate app and are out of the harness's scope by construction — but note that
the `ah-*` images already in the tree are captured against clearly seeded
identities, which is the standard the rest should meet.

### The smallest change that unblocks the largest share

Nothing here should be invented in this change. Stated plainly, in the order
that buys the most coverage per unit of work:

1. **A scripted provider fixture for the harness — done.** See "The scripted
   provider" below. It unblocked all six of the conversational `chat-*` keys —
   the ones listed under `replaced`.
2. **The overlay card sent on its own channel — done, and it needed no plugin
   change.** The earlier pass concluded these six needed a synthetic detector
   inside the work-assistant plugin. That was aiming at the wrong layer. The
   detector is not what the images show; the host's overlay card is, and the
   host builds that card in one place from one IPC message
   (`host-api-factory.ts` → `lvis:overlay:show`). `pushPluginOverlay` in
   `matrix.ts` composes the same `OverlayItem` and sends it on the same channel
   from the main process — the technique `chat-app-update` already used for
   `lvis:update:state` — so everything downstream is the production path:
   `OverlayContext`, `OverlayCardRegion`, the real `OverlayCard`, and the real
   imported-trigger insert behind the primary action, which the `-2` keys click
   for real. All six replaced; they carried the worst content in the backlog.
3. **Reuse of an already-provisioned Python venv — done, gated on a machine
   precondition.** `LVIS_SCREENSHOT_REAL_PYTHON=1` (one predicate,
   `REAL_PYTHON_CAPTURES` in `plugin-seed.ts`, read by plugin-seed, fixtures and
   the matrix together) hardlinks the host's existing venv into the isolated
   runtime. What it cannot supply is that venv, so the keys stay skipped unless
   the flag is set. The port that used to sit next to this was not a harness
   problem to solve either: the plugin now takes a `workerPort` setting, and the
   fix belongs to the product — a hardcoded port meant a second LVIS instance
   could not run local-indexer at all, screenshots or no screenshots.

   With that, the four panel keys capture end-to-end. Two app-side defects had
   to be fixed first, both found by the captures and neither specific to them:
   a plugin panel opened while the runtime was still starting bound a frame with
   no `lvis-plugin:` URL loader and could never load its own bundle, and the
   host's derived theme tokens were being filtered out of every payload sent to
   every plugin frame — see "What the captures found" below.

4. **The plugin `<webview>` guest is reachable — from the main process.** The
   earlier pass recorded the four `meeting-*` panel keys as unreachable on two
   counts, both of them wrong. Playwright cannot query a `<webview>`: from the
   renderer's side the guest is an element with no children. Electron can —
   `webContents.getAllWebContents()` returns the guest as a first-class
   `WebContents` and `executeJavaScript` runs in its document, which is the same
   `app.evaluate` channel the harness already used for IPC seeding, pointed one
   frame deeper. `waitInPluginGuest` in `matrix.ts` is that one helper: it waits
   for a control by selector and text, and optionally clicks it. The second
   count — that a populated minutes body needs a completed recording — was
   aiming past the store. `SessionStore` keeps one JSON file per finished
   session under the plugin's data directory, so a fabricated finalised session
   seeds exactly the state a real recording would have left, with no audio
   anywhere in the path. Synthesised mouse clicks at window coordinates were
   tried first and are recorded here as a dead end: they reach the guest, but
   not dependably — measured against the same frame, a click activated one
   control and passed straight through the one 40px above it.

What remains genuinely out of this repository's reach: `meeting-record` and
`meeting-record-stt` (a live microphone and a completed transcription),
`meeting-outlook-mail*` (an authorised mailbox), the `outlook-*` keys (a live
Microsoft authorisation window), and `agent-hub-*` (no bundle exists). Until those change,
the affected images have to be captured by hand — in which case they must be
captured **on a machine that does not apply the identity overlay, signed into a
demo identity, with a fabricated corpus**, and then amplification-checked before
they are committed.

## Worklist

### `reshoot` — 7

Shared preconditions for every row here: capture on a machine that does not
apply the identity overlay; sign in with a demo identity, never a working
account; connect no real mailbox, calendar, or file share; amplification-check
the result before committing.

| File | `screenshots.ts` key | Docs page(s) | Retake as |
| --- | --- | --- | --- |
| `meeting-outlook-mail.png` | `meeting-outlook-mail` | `/docs/host/integration-recipes` | **Highest severity in this list.** Two recipients with names, grades and full organisational paths, and a sender signature block carrying a department chain and a direct mobile number. Retake with fabricated recipients and a demo signature. |
| `meeting-outlook-mail-2.png` | `meeting-outlook-mail-2` | `/docs/host/integration-recipes` | Same recipients; signature partly in frame. Retake as the second step of the same fabricated flow. |
| `outlook-login-trigger.png` | `outlook-login-trigger` | `/docs/plugins/ms-graph` | A work address, colleague names, room and building codes and an organisational path — **and the identity overlay is drawn diagonally across the answer text**. This is the clearest case in the set that redaction cannot solve. Retake against a demo mailbox. |
| `outlook-login-window.png` | `outlook-login-window` | `/docs/plugins/ms-graph` | The form itself is empty and carries no personal data, **but the identity overlay is legible across the dialog**. Retake on a machine that does not apply it. *Disagreement with the earlier pass: this reads clean on inspection and is not — it is a reshoot solely because of the overlay.* |
| `outlook-login-after.png` | `outlook-login-after` | `/docs/plugins/ms-graph` | The signed-in mailbox address, a second person's name and their address, an internal policy notice — and the overlay, carrying a different trailing value than the one on the trigger frame. Retake against a demo mailbox with fabricated messages. |
| `meeting-record.png` | `meeting-record` | `/docs/plugins/meeting` | Briefing panel lists a mandatory internal training entry naming two employer sites. Retake with a fabricated day's agenda. |
| `meeting-record-stt.png` | `meeting-record-stt` | `/docs/plugins/meeting` | Same briefing plus an interim transcription of a real meeting. Retake from the fabricated recording. |

### `redact` — 3

Redaction is sufficient on these three, and only these three, because the
offending content is one contiguous region that is not what the image is there
to show. **None of the three carries the identity overlay** — verified by
amplification, which is what makes masking a complete fix rather than a partial
one. Every image on the `reshoot` list fails at least one of those two
conditions, most of them the first: the identifying content is the content the
screenshot exists to show.

| File | `screenshots.ts` key | Docs page(s) | Region, and why masking is enough |
| --- | --- | --- | --- |
| `agent-hub-my-work.png` | `agent-hub-my-work` | `/docs/plugins/agent-hub` | The board itself runs on seeded demo identities. Only the right-hand day-schedule column is real, pulled from a live calendar: mask that column. The subject of the shot is the personal board on the left, which is untouched. Note the plugin is decommissioned — confirm the page should still exist before spending effort. |
| `agent-hub-team-board.png` | `agent-hub-team-board` | `/docs/plugins/agent-hub` | Same shape: seeded team rows, real right-hand schedule column. Mask the right column only. Same decommissioning question applies. |
| `mp-admin-4.png` | `mp-admin-4` | `/docs/servers/marketplace/admin` | Mask the `Prefix` column of the key table. The screenshot exists to show that an admin can inventory and revoke keys, which the labels, roles, statuses and dates carry on their own. *Disagreement with the earlier pass: this is not clean. These are project-owned development keys on a server that rotates them, so exploitability is low and this is not an incident — but publishing a truncated prefix narrows a guess, and an admin key inventory should not be public regardless.* |

### `replaced` — 24

Captured by the harness from seeded data, amplification-checked, and recorded in
the manifest as `seeded` under the `host-capture-seed` account. Re-capture one
with `node scripts/capture-screenshots.mjs --skip-build --grep <key>`; the six
`chat-*` and six `work-assistant-*` rows need nothing else;
`plugin-permission-grant` needs one more thing, noted under the table. The two
approval-dock crops differ between runs by one row — the tool-call id — and are
otherwise byte-identical.

| File | `screenshots.ts` key | What the replacement shows |
| --- | --- | --- |
| `plugin-permission-grant.png` | `plugin-permission-grant` | The approval dock raised by a plugin's own first tool call, over that plugin's panel. This is the one that came off the third-party backlog. |
| `chat-question-card.png` | `chat-question-card` | An ask-user card with invented choices, from a scripted `ask_user_question` call. |
| `chat-todo-queue.png` | `chat-todo-queue` | A four-item session checklist and two queued messages, while a scripted answer streams. |
| `chat-tool-thinking.png` | `chat-tool-thinking` | A finished file read and a thinking body still arriving, captured inside the second turn. |
| `chat-permission-directory.png` | `chat-permission-directory` | The directory-level read grant, over an invented path outside the profile's allowed scope. Replaces a frame that printed the publisher's home directory in six places. |
| `chat-permission-risk.png` | `chat-permission-risk` | A HIGH-risk shell approval with its impact detail expanded. The verdict comes from the scripted reviewer — see the tamper check under "The scripted provider". |
| `chat-permission-llm-review.png` | `chat-permission-llm-review` | The in-flight review card for a shell call, captured while the scripted reviewer's answer is still streaming. |
| `work-assistant-conflict.png` | `work-assistant-conflict` | The real host overlay card for a fabricated schedule conflict, summary expanded so the alert is legible rather than clamped to two lines. Came off the third-party backlog. |
| `work-assistant-conflict-2.png` | `work-assistant-conflict-2` | The state after the card's primary action: the `overlay:calendar-conflict-prep` imported-trigger bubble, then a scripted reply detailing both events and offering three ways out. Replaces the highest-severity frame in the set — it printed a base64 calendar identifier from which a mailbox identifier was recoverable. |
| `work-assistant-reminder.png` | `work-assistant-reminder` | A fabricated pre-meeting reminder card. Replaces a frame carrying two work addresses and a colleague's name, grade and full organisational path. |
| `work-assistant-reminder-2.png` | `work-assistant-reminder-2` | Its confirmed state, showing the provenance bubble and a scripted prep summary. Replaces the second frame with a recoverable calendar identifier. |
| `work-assistant-meeting-end-trigger.png` | `work-assistant-meeting-end-trigger` | A fabricated meeting-end summary card. |
| `work-assistant-meeting-end-trigger-2.png` | `work-assistant-meeting-end-trigger-2` | Its confirmed state with the follow-up options. Replaces a frame of internal commercial subject matter. |
| `meeting-upcoming.png` | `meeting-upcoming` | The real upcoming-meeting panel over a fabricated prep seeded into `preps.json`. Replaces the frame that printed a live conference join link next to its meeting password, host key and meeting key, plus three people's names, grades and organisational paths. |
| `meeting-minutes.png` | `meeting-minutes` | The minutes detail view of a fabricated finalised session: summary, highlights, action items. |
| `meeting-minutes-2.png` | `meeting-minutes-2` | The 중간 리파인 sub-tab of the same session — two intermediate summaries over a growing prefix of the transcript. |
| `meeting-minutes-3.png` | `meeting-minutes-3` | The 전사 sub-tab of the same session — eight invented utterances across three role-labelled speakers. Replaces a verbatim transcript of other people's recorded speech. |
| `local-indexer-add-folder.png` | `local-indexer-add-folder` | A registered-but-unscanned folder under a fabricated corpus path, with the supported-format chips. Its caption promised an include/exclude dialog the panel has never had; the caption now describes the panel. |
| `local-indexer-indexing.png` | `local-indexer-indexing` | A scan genuinely in flight — the frame waits for the guest's own summary to report a processed document, so the counters, the current file and the folder's 스캔 중 row all carry real values rather than the zeroes of the instant after the button press. |
| `local-indexer-home.png` | `local-indexer-home` | The panel after a full scan of the fabricated corpus: eighteen documents, the folder marked 완료. Was a `keep` row that printed a real indexed folder. |
| `local-indexer-index-search.png` | `local-indexer-index-search` | The document filter narrowing the same eighteen to the twelve monthly reports. |
| `local-indexer-search.png` | `local-indexer-search` | A question answered out of the index the same run just built: one real `index_search` call over the fabricated corpus, its hit list open, and a scripted answer citing the two documents it returned. Replaces a frame that cited internal deck filenames. |
| `local-indexer-search-2.png` | `local-indexer-search-2` | The same shape asking where a document is. The answer prints the corpus path — the feature the caption promises — and that path now names a fabricated folder under the OS's own public directory. Replaces the highest-severity frame in the reshoot list: a full network path naming a file-server host, an administrative share and an individual's account. |
| `local-indexer-search-3.png` | `local-indexer-search-3` | The turn after it: the same answer reformatted into a one-page handout. Scripted as its own capture, because a capture cannot resume another capture's app. |

`plugin-permission-grant` and the four `meeting-*` rows are the ones that need
more than this repository: their panels come from sibling plugin repos, whose
`dist/` is not committed, so that clone has to be present and built (`bun install
&& bun run build`) before the harness can seed it. Without it the harness reports
the bundle missing and the key captures nothing. The six `chat-*` and six
`work-assistant-*` rows need no sibling clone.

The four `meeting-*` captures also run at a 1120px viewport rather than the
default 1600px, and that is load-bearing rather than cosmetic. The page shell
caps a plugin view at its `--reading-column-max` reading column, and this guest reserves a fixed
left gutter inside its own viewport: measured at a 1600px window the `<webview>`
is 912px, the guest starts its card 481px in and lays it out 477px wide, so the
last 46px — the right edge of every card and control — falls off the element. At
1120px the `<webview>` is 833px, close to the ~800px the host comment in
`plugin-ui-host.tsx` says these panels were authored for, and everything fits.
**That overflow is a real responsive bug in the plugin guest, not a harness
artefact**, and is worth an issue in the plugin repo independently of
screenshots.

Every string in the six `work-assistant-*` captures is invented in `matrix.ts`
rather than read from anything on the capturing machine, and every address in
them is at `example.invalid` — reserved by RFC 2606, so it cannot resolve to a
real mailbox. Rule 7 of the guard enforces that mechanically; see below.

### `keep` — 20

Inspected and clear: nothing identifies a third party, and no credential is in
frame. Two notes worth recording rather than acting on:

- `chat-permission-directory.png` and `chat-permission-risk.png` used to show the
  publisher's own home directory path across several fields. That is the
  publisher's own identifier, not a third party's, so it was recorded as `owner`
  and not masked — but both have since been re-captured from seeded data and are
  on the `replaced` list above, which removes the path anyway.
- `mp-plugin.png` shows a catalog card describing the internal-portal plugin.
  That names the internal system the in-flight de-identification change is
  generalising away from elsewhere in the docs. It is a policy question for that
  change's owner, not a privacy finding, so it is left alone here.

| File | `screenshots.ts` key | Docs page(s) |
| --- | --- | --- |
| `chat-app-update.png` | `chat-app-update` | `/docs/getting-started/updates` |
| `chat-plugin-panel.png` | `chat-plugin-panel` | `/docs/chat/plugin-panel`<br>`/docs/getting-started/login` |
| `outlook-logout.png` | `outlook-logout` | `/docs/plugins/ms-graph` |
| `mp-login.png` | `mp-login` | `/docs/servers/marketplace` |
| `mp-plugin.png` | `mp-plugin` | `/docs/servers/marketplace/plugins` |
| `mp-agents.png` | `mp-agents` | `/docs/servers/marketplace/agents` |
| `mp-mcp.png` | `mp-mcp` | `/docs/servers/marketplace/mcp` |
| `mp-skills.png` | `mp-skills` | `/docs/servers/marketplace/skills` |
| `mp-publisher.png` | `mp-publisher` | `/docs/servers/marketplace/publisher` |
| `mp-publisher-2.png` | `mp-publisher-2` | `/docs/servers/marketplace/publisher` |
| `mp-admin.png` | `mp-admin` | `/docs/servers/marketplace/admin` |
| `mp-admin-2.png` | `mp-admin-2` | `/docs/servers/marketplace/admin` |
| `mp-admin-3.png` | `mp-admin-3` | `/docs/servers/marketplace/admin` |
| `mp-admin-5.png` | `mp-admin-5` | `/docs/servers/marketplace/admin` |
| `ah-dashboard.png` | `ah-dashboard` | `/docs/servers/agent-hub` |
| `ah-workboard.png` | `ah-workboard` | `/docs/servers/agent-hub/workboard` |
| `ah-worklog.png` | `ah-worklog` | `/docs/servers/agent-hub/workboard` |
| `ah-inbox.png` | `ah-inbox` | `/docs/servers/agent-hub/inbox` |
| `ah-report.png` | `ah-report` | `/docs/servers/agent-hub/report` |
| `ah-subscription.png` | `ah-subscription` | `/docs/servers/agent-hub/subscription` |

### `superseded` — 17

The internal-portal plugin page and its images are removed by the in-flight
de-identification change. Listed for completeness so the count reconciles to 71;
no capture work belongs here, and this list should empty itself when that change
merges.

`ep-login`, `ep-attendance`, `ep-attendance-2`, `ep-attendance-3`, `ep-approval`,
`ep-parking`, `ep-meeting-room`, `ep-meeting-room-2`, `ep-meeting-room-3`,
`ep-meeting-room-4`, `ep-meeting-room-5`, `ep-video-call`, `ep-video-call-2`,
`ep-video-call-3`, `ep-video-call-4`, `ep-assistant`, `ep-assistant-2` — all on
`/docs/plugins/ep-api`.

## Order of work

1. Land the guard (done — see below) so nothing new arrives while the backlog drains.
2. Build the scripted provider (done — see "The scripted provider") and capture
   what it unblocks. That is where `plugin-permission-grant` and the six `chat-*`
   replacements came from.
3. Apply the three `redact` masks. Cheap, and removes real exposure immediately.
4. Re-shoot the six `work-assistant-*` images (done — see the `replaced` table).
   Highest concentration of third-party content, and all six went at once.
5. Re-shoot the `meeting-*` panel keys against a fabricated corpus (done — see
   the `replaced` table). The rest of the `meeting-*` and `outlook-*` clusters
   need a demo mailbox and a real recording, which this repository cannot supply.
6. Re-shoot the `local-indexer-*` images against a fabricated corpus (done — all
   seven, four panel keys and three answers, are in the `replaced` table).
7. Lower `pendingReplacementBaseline` with each batch. The gate fails if the
   backlog shrinks and the baseline does not follow.
8. Only once replacements are in place, remove anything left over.

## What the captures found

Driving real panels rather than describing them turns the harness into a
regression check, and the `local-indexer-*` batch surfaced four defects. All four
are fixed — the two below, the picker one found when the third was re-probed, and
the unreachable local endpoint, whose fix is a host egress-policy change rather
than a screenshot one. Two further findings are not defects at all — they are host
behaviours the harness was silently relying on, or silently violating, and they
are recorded because the next person to move a capture will hit them.

**Fixed — a plugin panel opened during startup could never load its own bundle.**
A renderer frame is handed its set of URL loaders once, when it begins loading. A
scheme registered on the session after that is not in the set, so every request
the frame makes for it fails with `ERR_UNKNOWN_URL_SCHEME` before reaching any
handler, for the life of the frame — no retry recovers it. The window is up while
plugins are still starting, so a panel opened in that window attached a
`<webview>` with no `lvis-plugin:` entry and stayed on "Plugin UI failed to
load" until the app was restarted. The renderer now asks main to install the
partition's policy and waits for the answer before it renders the `<webview>` at
all (`lvis:plugin:ensure-partition`), the asset scheme registers as soon as the
partition exists rather than waiting for a resolved install root, and boot
installs each loaded plugin's policy before starting any of them. Intermittent
before, 6/6 across five consecutive runs after.

**Fixed — the host's derived theme tokens never reached any plugin frame.** The
theme payload validator accepted plain `hsl()`, hex, lengths, weights and
durations. Seven of the tokens the host computes are `color-mix()` strings — the
tinted-surface set added so plugins would stop hand-rolling their own mixes —
and one is `hsla()`, and the easing curves are `cubic-bezier()`. All eleven were
silently dropped from every payload sent to every plugin webview, and each frame
kept the SDK's static fallback, which is a **dark**-theme value. In a light shell
that renders as a dark chip: the local-indexer's 진행 중 pill was drawn navy on
navy, unreadable, in the published-candidate frame. The validator now composes
its pattern from the shapes the producer actually emits, and a test walks every
real bundle through `bundleToPluginTokens` and asserts nothing is dropped, so the
two cannot drift apart again silently.

**Fixed — selecting a plugin whose runtime is still starting did nothing.** The
command picker lists a preparing plugin's panel on purpose (`App.tsx` builds
those rows from `card.uiExtensions`, so a plugin can be reached while its
runtime comes up), but `handleViewSelect` refused any key with no entry in
`pluginViews` — and a preparing plugin has not registered its view yet. The
picker closed, nothing opened, and nothing brought the user back when the view
landed seconds later, so a first-run panel simply did not respond to the click.
Reproduced here as roughly one capture run in three: the local-indexer panel
never mounted, and the harness's own `openPluginPanel` retry loop is what hid
it. Selection now opens the destination and the host holds its loading state
until the view registers; the fall-back-to-home effect (whose job is an
UNINSTALLED plugin) no longer undoes that navigation.

**Not reproducible — "a reloaded plugin panel never recovers".** Recorded here
in the previous pass. Re-probed against this branch by reloading the guest
`webContents` from the main process with a marker set in the guest first: the
marker is gone afterwards, so the reload really happened, and the bridge, the
mounted plugin UI and the host overlay all come back. The partition-ordering fix
above is the likely reason it no longer bites.

**Fixed — the plugin's own `embeddingEndpoint` setting could not be used.** The
local-indexer advertises an OpenAI-compatible endpoint (LM Studio, LiteLLM, an
internal proxy). Its worker never calls that endpoint directly; egress goes
through the plugin's broker, whose upstream leg is `hostApi.hostFetch`, and that
chokepoint was https-only with no opt-out and matched a manifest allow-list with
no loopback entry. So a local endpoint was denied before it was reached and every
document ended in a 504 — a control that could not control anything, the same
failure mode as an env-only lever.

The exemption is narrow and it is the allow-list that grants it: a manifest may
now declare the loopback literals `localhost` / `127.0.0.1` / `::1` in
`networkAccess.allowedDomains`, and only for a host declared that way does
`host-fetch-guard.ts` permit cleartext http and open the loopback axis of the
SSRF check. Cleartext is not taken on the hostname's word — every resolved
address must be loopback, so a `localhost` pointed off-machine by a poisoned
hosts file or a rebinding answer is denied rather than sent in the clear. Nothing
else moves: an ordinary allow-listed host still cannot be reached over http; a
declared loopback endpoint opens neither the LAN nor any other host; and
`allowPrivateNetworks` (RFC1918/ULA) neither grants loopback nor is required for
it — the two axes stay independent in both directions. The captures still run
with embedding off, which is now a harness choice rather than the only option.

**Behaviour — the capture profile has to live inside the OS temp directory.**
`baseAllowedDirectories()` puts `os.tmpdir()` on every turn's allow-list, and the
harness sets `HOME` to its per-run profile. A scenario operand like `~/Documents`
is therefore an already-allowed path only because the profile sits under
`os.tmpdir()`. Moving the profile out — which is what keeping the operator's
account name out of published frames first appeared to require — flipped that:
the Layer 1 out-of-allowed-dir gate fired first and short-circuited the reviewer,
so `chat-permission-llm-review`, which captures a review still in flight, timed
out waiting for a card that run would never render. No profile path reaches a
frame, so only the demo corpus needed a neutral home; the profile stayed put, and
`fixtures.ts` now says why.

**Behaviour — a plugin's tools are not callable until the turn activates the
plugin.** `resolveToolScope` seeds a turn's active plugin set from the previous
turn, so the first turn of a fresh chat has none, and `invocation-runner.ts`
refuses a plugin tool whose plugin is outside that set — before the tool runs,
with a 권한 차단 result rendered in the frame. A scripted script that opens with
the plugin's own tool captures that refusal, which is the gate working as
designed. The fix is to script what a real session does first: a `request_plugin`
turn, prepended once in `localIndexerChatScenario` so no individual key can
forget it.

## What is not addressed here

**The current images remain in git history.** Replacing a file in a later commit
does not remove the earlier blob; anyone with the repository can still retrieve
it. Closing that means rewriting history — `git filter-repo` over the affected
paths — followed by a force update of every affected branch and tag, invalidating
every outstanding fork, clone, and open change based on the rewritten range. That
is a coordinated operation with real breakage, and it is the owner's call, not a
side effect of this worklist. Two things worth weighing: the site has already
served these images publicly, so history rewriting reduces future retrieval but
does not undo past exposure; and the conferencing credentials in
`meeting-upcoming.png` are the one class where rotation is both possible and more
effective than any history operation — that meeting's password and host key
should simply be considered burned.

**This worklist does not re-audit the superseded internal-portal set.** Those 17
are handled by the in-flight change and were not re-inspected here.

## The guard

`scripts/check-screenshot-provenance.mjs`, wired into `ci.yml` and `web-ci.yml`,
with `scripts/check-screenshot-provenance-self-test.mjs` beside it.

### What it enforces

Every tracked image under `web/public/` must have an entry in
`web/screenshot-provenance.json` declaring what class of data is on screen and,
for a seeded capture, which demo account took it and that it was
amplification-checked. Entries that name no file, and files that name no entry,
both fail. The count of images still carrying third-party content is ratcheted
in both directions against `pendingReplacementBaseline`: adding a new one fails,
and re-shooting one without lowering the baseline also fails.

It also scans the capture harness itself. Every email address written anywhere
under `test/screenshots/` must sit in a domain nobody can own — `example.com`,
`example.net`, `example.org`, or anything under `.example`, `.invalid`, `.test`
or `.localhost` (RFC 2606 and RFC 6761). This is the one identity leak the gate
can see mechanically, and it is worth seeing: a replacement capture renders the
harness's own seeded strings, so an address pasted in there — copied out of the
very image being replaced, most likely — ends up in a published frame. A real
domain in a scenario fails the build with the domain named.

The practical effect is that a new screenshot cannot enter the tree without
someone writing down where its content came from, cannot enter at all if the
answer is "from a real session", and cannot be *manufactured* carrying an
address that belongs to anyone.

### What it cannot see

**It does not read pixels.** There is no OCR and no image model. It cannot tell
you whether a name, an address, a hostname, or a credential is visible in a PNG.
It cannot detect the identity overlay — that takes the deliberate amplification
pass above, run by a person. Rule 7 is not an exception to this: it reads the
harness's *source*, so it constrains what a future capture can be made to say,
and says nothing about any image already in the tree.

**Rule 7 catches addresses, not identities.** A fabricated person's name, an org
chart path, or a job grade passes it untouched. Use role labels
("데모 진행자", "문서 담당") rather than invented person names when seeding a
capture — an invented name is still a name, and some real person has it.

An OCR-free heuristic over image bytes catches almost nothing real here: the
severity of these findings comes from *meaning* — that a string is somebody's
address, that a base64 blob decodes to a mailbox — not from any property visible
in a histogram. A gate that guessed would produce false positives on clean
screenshots, teach people to override it, and be worse than no gate.

So the gate does the enforceable thing instead: it makes the claim explicit,
attributable, and reviewable in the diff, at the moment the image arrives. A
wrong claim is a person's error the diff records. A missing claim is mechanical,
and that is what this blocks.

### Proof it works

Run against a fixture repository, eight expectations, all holding:

```
$ node scripts/check-screenshot-provenance-self-test.mjs
PASS blocks an undeclared image (exit 1, expected 1)
PASS blocks a new third-party image over the baseline (exit 1, expected 1)
PASS blocks a seeded claim with an account outside the allow-list (exit 1, expected 1)
PASS blocks a seeded claim that is not overlay-checked (exit 1, expected 1)
PASS blocks a stale entry (exit 1, expected 1)
PASS blocks a baseline left above the real backlog (exit 1, expected 1)
PASS blocks a harness address at an ownable domain (exit 1, expected 1)
PASS passes a properly declared seeded capture (exit 0, expected 0)
OK — 8/8 expectations held.
```

And exercised against this repository by staging one extra image and declaring
it three ways, plus one run with the baseline left where it was after a
replacement. Numbers below are what the gate printed at the current HEAD:

| Declaration | Gate says | Exit |
| --- | --- | --- |
| none — image staged, no manifest entry | `undeclared image: web/public/screenshots/tamper-probe.png has no entry in web/screenshot-provenance.json` | 1 |
| `data: "third-party"` | `ratchet: 20 entries carry third-party content but the baseline is 19` | 1 |
| `data: "seeded"`, allow-listed account, overlay-checked | `OK — 57 tracked images, all declared; 19 awaiting replacement (baseline 19)` | 0 |
| image removed again, baseline left at 20 | `ratchet: 19 entries carry third-party content but the baseline still says 20` | 1 |

Reproduce the first three by copying any existing screenshot to a new name under
`web/public/screenshots/`, `git add`-ing it, and running the gate; the fourth by
raising `pendingReplacementBaseline` by one on a clean tree. The counts move with
the tree, so re-derive them rather than quoting these if the backlog has changed.

## The scripted provider

The conversational keys need a model turn in flight. The harness gets one without
any test-only branch in the host: it starts a local OpenAI-compatible endpoint on
loopback and points the isolated profile's LLM settings at it. `openai-compatible`
is an API-key-optional vendor whose `baseUrl` is an ordinary user setting, and
`selectProviderRuntimeFetch` already grants a configured self-hosted base URL
loopback access locked to that one origin. Nothing under `src/` knows the
endpoint is a fixture; it takes the same path a self-hosted endpoint takes.

A scenario declares `scriptedScript.turns` — one entry per model call it causes —
and each entry lists reasoning text, answer text, and tool calls to stream, with
an optional per-chunk delay so a capture can land mid-turn. Two things keep it
honest:

- **It fails closed.** A `POST /chat/completions` can leave the handler three
  ways: the fixed connectivity-probe reply, a turn the script named, or an
  error. There is no fourth branch, and none of the three improvises an answer
  to what was asked. A request the script does not anticipate gets the error and
  is recorded on the handle; `capture.spec.ts` asserts that list is empty after
  the capture, so a drifted script fails the run instead of quietly producing a
  frame of the error state.
  Trailing turns left unconsumed are not a failure and are not checked — a
  mid-turn capture stops before the tail of its script on purpose.
- **It routes by the prompt the host actually sends.** `pingProvider`'s
  connectivity probe is answered before the turn queue is consulted; the
  permission reviewer's classification call is matched against
  `PERMISSION_REVIEWER_SYSTEM_PROMPT`, which `LlmRiskClassifier` sends verbatim;
  anything else is a conversation turn, whose system prompt is composed per
  session rather than being a constant, so there is nothing to compare it
  against. A turn may declare which of the two callers it answers. Both markers
  are imported from the modules that define them rather than copied, so an edit
  to either prompt moves the check with it.

### What "the reviewer path works" rests on

The claim that the reviewer verdict in `chat-permission-risk` comes from the
script — rather than from the rule classifier the LLM verdict composes with —
was checked by changing it. Replacing the scripted `"level": "high"` with
`"level": "low"` and re-running the key on macOS at this commit: no approval
dock appears at all, the shell call is auto-approved under the threshold, the
turn continues, and the capture fails because the host then asks for turns the
script does not have. Restoring `high` restores the dock. That is the whole
evidence for the claim, and it is worth more than the frame looking right.

The routing itself was checked the same way: relabelling that turn
`expect: 'assistant'` makes the run fail with `scripted provider expected a
assistant request, got reviewer`, so the endpoint is genuinely classifying the
reviewer's call rather than defaulting everything to one lane.

Two settings have to be in place for that call to happen, and both are named on
the scenario: `reviewerMode: 'llm'` wires the reviewer to the scripted endpoint,
and `executionMode: 'auto'` is what routes a foreground shell call through it —
`PermissionManager.shouldRouteForegroundReviewer` requires `mode === "auto"`, so
under the default mode such a call reaches the dock straight from the category
rule with no classification call in between. A scenario that declares an
`expect: 'reviewer'`
turn without both of them will not fail: the turn simply goes unrequested, which
is the direction `violations` deliberately does not check.

### It does not run in CI

The harness has its own Playwright config (`test/screenshots/playwright.config.ts`);
the repo-root config is scoped to `./test/e2e` and does not pick it up, and
nothing under `.github/workflows` invokes the harness config. What CI does run
for screenshots is the provenance gate (`check:screenshot-provenance`) and its
self-test, which read the manifest and the tracked file list — neither can see a
capture that stopped working. So a green CI run is not evidence about this lane
in either direction; the evidence is a local capture run.
