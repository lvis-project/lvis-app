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
| `reshoot` | 23 | Must be re-captured. Redaction cannot fix it, or would destroy what the image is there to show. |
| `redact` | 3 | One contiguous region carries the problem and is not the subject of the shot. |
| `keep` | 22 | Nothing on screen identifies a third party or exposes a credential. |
| `superseded` | 17 | The internal-portal plugin page and its images are removed by the in-flight de-identification change. No capture work here. |
| `replaced` | 1 | Re-captured from seeded data and no longer in the backlog: `plugin-permission-grant`. |

Six images have been replaced with seeded captures so far. Only one of them —
`plugin-permission-grant` — was in the third-party backlog, so the ratchet moved
26 → 25. The other five were `keep` rows whose replacement is still worth having:
two of them printed the publisher's own home directory across several fields, and
all five now come from the harness rather than from a working session.

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
wallpaper, not a stamp. Both are recorded here as clean of the overlay — they
are on the re-shoot list for their content, not for this.

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
is not a docs-site key. Of the remaining 36, **8 capture end-to-end today**:
`chat-app-update`, `chat-question-card`, `chat-todo-queue`, `chat-tool-thinking`,
`chat-permission-directory`, `chat-permission-risk`, `plugin-permission-grant`,
`meeting-upcoming`. The five conversational ones among those are new — they are
what the scripted provider below unblocked. The rest carry an explicit `skip`
with a stated blocker. Those blockers are real, not missing effort:

| Blocked group | Blocker |
| --- | --- |
| `chat-permission-llm-review` | The verdict is scriptable now, but the transcript has no surface while the reviewer call is outstanding — the group renders its "working" header and nothing else. Renderer change, not a harness one. |
| `chat-plugin-panel` | Regressed: the work-assistant bundle's factory spawns a confined child, and in the isolated profile the ASRT sandbox is not active yet at that point, so the plugin fails to load. Not caused by this change; it also fails on an unmodified checkout. |
| `local-indexer-*` (7) | The bundle's `start()` throws without a provisioned Python interpreter, so the runtime tears the plugin down and no UI provider registers. |
| `meeting-*` minutes / recorder (7) | Live inside the plugin `<webview>`, which Playwright cannot click through, and need a completed transcription or mail authorisation to populate. |
| `outlook-*` (4) | The manifest declares a login tool, so selecting the panel goes straight to a live authorisation window. |
| `work-assistant-*` (6) | Host notification cards emitted when a detector fires. Firing one needs a real external signal; the plugin ships no synthetic trigger. |
| `agent-hub-*` (2) | No such plugin bundle exists in the workspace. |

`meeting-upcoming` captures, but only in its empty state, with the plugin's
first-tool-call approval dock over the lower half of the frame. Its caption
promises a populated agenda, so that capture is **not** a usable replacement and
the image stays in the backlog.

The `mp-*`, `ah-*` and internal-portal keys are web/server screens from a
separate app and are out of the harness's scope by construction — but note that
the `ah-*` images already in the tree are captured against clearly seeded
identities, which is the standard the rest should meet.

### The smallest change that unblocks the largest share

Nothing here should be invented in this change. Stated plainly, in the order
that buys the most coverage per unit of work:

1. **A scripted provider fixture for the harness — done.** See "The scripted
   provider" below. It unblocked five of the six `chat-*` keys; the sixth
   (`chat-permission-llm-review`) turned out to be blocked by the renderer, not
   by the provider.
2. **A synthetic detector trigger in the work-assistant plugin.** A dev-only tool
   that emits a fabricated schedule-conflict / reminder / meeting-end event
   unblocks all six `work-assistant-*` keys. These are the images carrying the
   most third-party content, so this is the highest-value item by risk removed.
3. **Python provisioning in the harness profile**, or a plugin start path that
   registers its UI provider before the worker is healthy, for the seven
   `local-indexer-*` keys.

Items 2 and 3 are plugin-repo changes and belong in their own changes, in their
own repositories. Nothing in this repository unblocks them. Until they land, the affected images have to be captured by
hand — in which case they must be captured **on a machine that does not apply
the identity overlay, signed into a demo identity, with a fabricated corpus**,
and then amplification-checked before they are committed.

## Worklist

### `reshoot` — 23

Shared preconditions for every row here: capture on a machine that does not
apply the identity overlay; sign in with a demo identity, never a working
account; connect no real mailbox, calendar, or file share; amplification-check
the result before committing.

| File | `screenshots.ts` key | Docs page(s) | Retake as |
| --- | --- | --- | --- |
| `local-indexer-indexing.png` | `local-indexer-indexing` | `/docs/plugins/local-indexer` | Progress state over an internal work-document tree; the path and a deck filename appear in four places, so masking would leave the shot unreadable. Index a fabricated sample corpus under a neutral folder name. |
| `local-indexer-add-folder.png` | `local-indexer-add-folder` | `/docs/plugins/local-indexer` | Same internal path in the folder row. Also note the caption promises an add-folder dialog with include/exclude patterns and the current image does not show one — retake against what the caption claims. |
| `local-indexer-search.webp` | `local-indexer-search` | `/docs/plugins/local-indexer` | Answer cites internal deck filenames and internal project subject matter. Re-run the same question shape against the fabricated corpus. |
| `local-indexer-search-2.webp` | `local-indexer-search-2` | `/docs/plugins/local-indexer` | **Highest severity in this list.** The answer body is a full network path: internal file-server host, an administrative share, an individual's account name, and their work directory. The caption advertises "the exact path" as the feature, so redaction removes the subject. Retake against a fabricated share whose host and account are invented. |
| `local-indexer-search-3.webp` | `local-indexer-search-3` | `/docs/plugins/local-indexer` | Reformats the same internal project material. Retake as the third step of the fabricated-corpus sequence so all three read as one flow. |
| `local-indexer-index-search.png` | `local-indexer-index-search` | `/docs/plugins/local-indexer` | Internal work path plus a description of an internal architecture diagram. Retake against the fabricated corpus. |
| `meeting-upcoming.png` | `meeting-upcoming` | `/docs/plugins/meeting` | **Highest severity in this list.** Carries live conferencing credentials — a join link with an embedded meeting identifier, a meeting password, a host key and a meeting key — plus an organiser's name and two attendees' names, grades and full organisational paths. Retake with a fabricated meeting and invented credentials. The harness captures this key today, in its empty state. |
| `meeting-minutes.png` | `meeting-minutes` | `/docs/plugins/meeting` | Body is a real internal meeting summary under its real title. Retake from a fabricated recording. |
| `meeting-minutes-2.png` | `meeting-minutes-2` | `/docs/plugins/meeting` | Interim summaries of the same real meeting, including a named outside company. Retake from the same fabricated recording. |
| `meeting-minutes-3.png` | `meeting-minutes-3` | `/docs/plugins/meeting` | Verbatim speaker-attributed transcript of a real meeting. This is other people's recorded speech; nothing short of a new recording fixes it. |
| `meeting-outlook-mail.png` | `meeting-outlook-mail` | `/docs/host/integration-recipes` | **Highest severity in this list.** Two recipients with names, grades and full organisational paths, and a sender signature block carrying a department chain and a direct mobile number. Retake with fabricated recipients and a demo signature. |
| `meeting-outlook-mail-2.png` | `meeting-outlook-mail-2` | `/docs/host/integration-recipes` | Same recipients; signature partly in frame. Retake as the second step of the same fabricated flow. |
| `outlook-login-trigger.png` | `outlook-login-trigger` | `/docs/plugins/ms-graph` | A work address, colleague names, room and building codes and an organisational path — **and the identity overlay is drawn diagonally across the answer text**. This is the clearest case in the set that redaction cannot solve. Retake against a demo mailbox. |
| `outlook-login-window.png` | `outlook-login-window` | `/docs/plugins/ms-graph` | The form itself is empty and carries no personal data, **but the identity overlay is legible across the dialog**. Retake on a machine that does not apply it. *Disagreement with the earlier pass: this reads clean on inspection and is not — it is a reshoot solely because of the overlay.* |
| `outlook-login-after.png` | `outlook-login-after` | `/docs/plugins/ms-graph` | The signed-in mailbox address, a second person's name and their address, an internal policy notice — and the overlay, carrying a different trailing value than the one on the trigger frame. Retake against a demo mailbox with fabricated messages. |
| `meeting-record.png` | `meeting-record` | `/docs/plugins/meeting` | Briefing panel lists a mandatory internal training entry naming two employer sites. Retake with a fabricated day's agenda. |
| `meeting-record-stt.png` | `meeting-record-stt` | `/docs/plugins/meeting` | Same briefing plus an interim transcription of a real meeting. Retake from the fabricated recording. |
| `work-assistant-conflict.png` | `work-assistant-conflict` | `/docs/plugins/work-assistant` | Internal training entry and employer site names. **A region of this image has already been manually blurred**, which is direct evidence something identifying was in frame; treat the unblurred remainder as unreviewed. Retake from a synthetic conflict event. |
| `work-assistant-conflict-2.png` | `work-assistant-conflict-2` | `/docs/plugins/work-assistant` | **Highest severity in this list.** The card body prints a base64 calendar item identifier from which a mailbox identifier is recoverable, alongside internal schedule entries. Retake from a synthetic event so the identifier is fabricated. |
| `work-assistant-reminder.png` | `work-assistant-reminder` | `/docs/plugins/work-assistant` | **Highest severity in this list.** Two work addresses — a system sender and the signed-in user — plus a colleague's name, grade and full organisational path. Retake from a synthetic reminder. |
| `work-assistant-reminder-2.png` | `work-assistant-reminder-2` | `/docs/plugins/work-assistant` | A colleague's name, grade, organisational path and team, plus **a second base64 calendar item identifier**. *Disagreement with the earlier pass: the recoverable mailbox identifier appears on two images, not one — this row and the conflict row above.* |
| `work-assistant-meeting-end-trigger.png` | `work-assistant-meeting-end-trigger` | `/docs/plugins/meeting`<br>`/docs/plugins/work-assistant`<br>`/docs/routines/meeting-end` | Real meeting title and internal commercial subject matter; a region is already manually blurred. Retake from a synthetic meeting-end event. |
| `work-assistant-meeting-end-trigger-2.png` | `work-assistant-meeting-end-trigger-2` | `/docs/plugins/meeting`<br>`/docs/plugins/work-assistant`<br>`/docs/routines/meeting-end` | Expanded card carrying internal commercial terms. No personal data, but not publishable business content. Retake from the same synthetic event. |

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

### `replaced` — 6

Captured by the harness from seeded data, amplification-checked, and recorded in
the manifest as `seeded` under the `host-capture-seed` account. Reproduce any of
them with `node scripts/capture-screenshots.mjs --skip-build --grep <key>`.

| File | `screenshots.ts` key | What the replacement shows |
| --- | --- | --- |
| `plugin-permission-grant.png` | `plugin-permission-grant` | The approval dock raised by a plugin's own first tool call, over that plugin's panel. This is the one that came off the third-party backlog. |
| `chat-question-card.png` | `chat-question-card` | An ask-user card with invented choices, from a scripted `ask_user_question` call. |
| `chat-todo-queue.png` | `chat-todo-queue` | A four-item session checklist and two queued messages, while a scripted answer streams. |
| `chat-tool-thinking.png` | `chat-tool-thinking` | Two file reads over a fabricated note, with the thinking row expanded. |
| `chat-permission-directory.png` | `chat-permission-directory` | The directory-level read grant, over an invented path outside the profile's allowed scope. Replaces a frame that printed the publisher's home directory in six places. |
| `chat-permission-risk.png` | `chat-permission-risk` | A HIGH-risk shell approval with its impact detail expanded, verdict supplied by the scripted reviewer. |

### `keep` — 22

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
| `chat-permission-llm-review.png` | `chat-permission-llm-review` | `/docs/chat/permissions/llm-review` |
| `chat-app-update.png` | `chat-app-update` | `/docs/getting-started/updates` |
| `chat-plugin-panel.png` | `chat-plugin-panel` | `/docs/chat/plugin-panel`<br>`/docs/getting-started/login` |
| `local-indexer-home.png` | `local-indexer-home` | `/docs/plugins/local-indexer` |
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
`ep-video-call-3`, `ep-video-call-4`, `ep-lgenie`, `ep-lgenie-2` — all on
`/docs/plugins/lge-api`.

## Order of work

1. Land the guard (done — see below) so nothing new arrives while the backlog drains.
2. Build the scripted provider (done — see "The scripted provider") and capture
   what it unblocks. That is where `plugin-permission-grant` and the five `chat-*`
   replacements came from.
3. Apply the three `redact` masks. Cheap, and removes real exposure immediately.
4. Re-shoot the six `work-assistant-*` images. Highest concentration of
   third-party content, and item 2 in the enabling-change list unblocks all six
   at once.
5. Re-shoot the `meeting-*` and `outlook-*` clusters against a demo mailbox and a
   fabricated recording.
6. Re-shoot the seven `local-indexer-*` images against a fabricated corpus.
7. Lower `pendingReplacementBaseline` with each batch. The gate fails if the
   backlog shrinks and the baseline does not follow.
8. Only once replacements are in place, remove anything left over.

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

The practical effect is that a new screenshot cannot enter the tree without
someone writing down where its content came from, and cannot enter at all if the
answer is "from a real session".

### What it cannot see

**It does not read pixels.** There is no OCR and no image model. It cannot tell
you whether a name, an address, a hostname, or a credential is visible in a PNG.
It cannot detect the identity overlay — that takes the deliberate amplification
pass above, run by a person.

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

Run against a fixture repository, seven expectations, all holding:

```
$ node scripts/check-screenshot-provenance-self-test.mjs
PASS blocks an undeclared image (exit 1, expected 1)
PASS blocks a new third-party image over the baseline (exit 1, expected 1)
PASS blocks a seeded claim with an account outside the allow-list (exit 1, expected 1)
PASS blocks a seeded claim that is not overlay-checked (exit 1, expected 1)
PASS blocks a stale entry (exit 1, expected 1)
PASS blocks a baseline left above the real backlog (exit 1, expected 1)
PASS passes a properly declared seeded capture (exit 0, expected 0)
OK — 7/7 expectations held.
```

And exercised against this repository by staging one extra image and declaring
it three ways, plus one run with the baseline left where it was after a
replacement. Numbers below are what the gate printed at the current HEAD:

| Declaration | Gate says | Exit |
| --- | --- | --- |
| none — image staged, no manifest entry | `undeclared image: web/public/screenshots/tamper-probe.png has no entry in web/screenshot-provenance.json` | 1 |
| `data: "third-party"` | `ratchet: 26 entries carry third-party content but the baseline is 25` | 1 |
| `data: "seeded"`, allow-listed account, overlay-checked | `OK — 57 tracked images, all declared; 25 awaiting replacement (baseline 25)` | 0 |
| image removed again, baseline left at 26 | `ratchet: 25 entries carry third-party content but the baseline still says 26` | 1 |

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

- **It fails closed.** A request the script does not anticipate is answered with
  a transport error, never an improvised completion, and is recorded on the
  handle. `capture.spec.ts` asserts that list is empty after the capture, so a
  drifted script fails the run instead of quietly producing a frame of the
  error state. Trailing turns left unconsumed are not a failure — a mid-turn
  capture stops before the tail of its script on purpose.
- **It routes by the prompt the host actually sends.** `pingProvider`'s
  connectivity probe is answered inline and never consumes a scripted turn; the
  permission reviewer's classification call is recognised by
  `PERMISSION_REVIEWER_FRAMEWORK_VERSION`, and a turn may declare which of the
  two callers it answers. Both markers are imported from the modules that define
  them rather than copied, so an edit there breaks the fixture instead of
  silently mis-routing.

`chat-permission-risk` is the proof the reviewer path works: its HIGH verdict is
scripted, and the dock renders the risk branch from it.
