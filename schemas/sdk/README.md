# SDK-owned schema snapshots

The files here are **not host-owned**. They are byte-for-byte copies of
`lvis-plugin-sdk:schemas/*.schema.json` at a released SDK tag, and the SDK is
where a change to them belongs. Editing a copy here does not change what the
marketplace admits — it only makes the host disagree with it.

Compare with `../plugin-manifest.schema.json`, which is the opposite
arrangement: the host owns the manifest shape, and the SDK mirrors it.

## What reads them

`skill-package.schema.json` carries `$defs/skillComponent`, the definition of
SKILL.md front matter for both delivery paths — a standalone skill package and
a skill bundled in a plugin's `skills[]` directory. `src/main/skill-store.ts`
implements that definition, and
`src/main/__tests__/skill-front-matter-contract.test.ts` reads the name rule
and the field list straight out of this file to assert the implementation
still matches. Nothing loads it at runtime.

## Refreshing

Copy the file from an SDK checkout at the tag you are moving to, verbatim:

```
cp <lvis-plugin-sdk>/schemas/skill-package.schema.json schemas/sdk/
```

Then run the contract test. If the rule or the field list moved, that test
fails and names what has to change in the host.
