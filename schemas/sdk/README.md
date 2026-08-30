# SDK-owned schema snapshots

The schema files here are **not host-owned**. They are byte-for-byte copies of
`lvis-plugin-sdk:schemas/*.schema.json` at a released SDK tag, and the SDK is
where a change to them belongs. Editing a copy here does not change what the
marketplace admits — it only makes the host disagree with it, and the gates
below exist to say so out loud when it happens.

Contrast `../plugin-manifest.schema.json`, which is the opposite arrangement:
the host owns the manifest shape and the SDK mirrors it.

## What reads them

`skill-package.schema.json` carries `$defs/skillComponent`, the definition of
SKILL.md front matter for both delivery paths — a standalone skill package and
a skill bundled in a plugin's `skills[]` directory. `src/main/skill-store.ts`
implements that definition, and
`src/main/__tests__/skill-front-matter-contract.test.ts` reads the name rule
and the field list straight out of this file to assert the implementation
still matches. Nothing loads it at runtime.

`sources.json` records where each file came from — repository, tag, and the
sha256 of the bytes at the moment the snapshot was taken.

## The two gates

A snapshot with no gate is a copy that is correct the day it is written and
silently wrong afterwards. Two different things go wrong, so there are two
checks:

| check | what it catches | needs network |
| --- | --- | --- |
| `bun run check:sdk-schemas` | the committed bytes no longer hash to what `sources.json` records — someone edited the copy | no |
| `bun run check:sdk-schemas:verify` | the recorded tag did not publish these bytes (provenance), or the SDK has moved since (drift) | yes |

The offline check also runs inside the test suite, so every pull request pays
it. The networked one runs in `.github/workflows/sdk-schema-drift.yml`, on
pull requests that touch this directory and on a daily schedule — drift is
created by a merge in the *other* repository, which no pull request here would
otherwise notice.

## Re-syncing

Do not copy the file by hand: the recorded hash would go stale and the offline
gate would fail on the next run. Use the script, which fetches, writes, and
re-records in one step:

```
bun run sync:sdk-schemas -- --ref v13.3.0
```

Then run the front-matter contract test. If the rule or the field list moved,
that test fails and names what has to change in the host — which is the point:
the snapshot is how a change in the SDK's contract becomes a visible, failing
obligation here rather than a silent divergence.
