# Third-Party Notices

LVIS (lvis-app) is licensed under the MIT License (see [LICENSE](./LICENSE)).
This file attributes third-party software that ships with, or is bundled into,
LVIS distributions but is licensed separately from LVIS itself. Listing a
component here does not change its license, nor relicense LVIS.

---

## @anthropic-ai/sandbox-runtime

- **Version:** 0.0.59 (pinned, exact)
- **License:** Apache License, Version 2.0
- **Copyright:** © Anthropic PBC
- **Repository:** https://github.com/anthropic-experimental/sandbox-runtime
- **Full license text:** bundled in the installed package at
  `node_modules/@anthropic-ai/sandbox-runtime/LICENSE`
  (also available at https://www.apache.org/licenses/LICENSE-2.0)

The Anthropic Sandbox Runtime (ASRT) wraps OS-level security boundaries around
spawned processes. LVIS distributions bundle ASRT's prebuilt vendor binaries
(Linux `seccomp` BPF filter + loader, Windows `srt-win`) under
`node_modules/@anthropic-ai/sandbox-runtime/vendor/`. These binaries are
extracted from the Electron asar archive at packaging time (see the
`build.asarUnpack` entry in `package.json`) so they remain executable at
runtime.

A copy of the Apache License 2.0, as required by Section 4 of the license,
accompanies the bundled package at the path noted above.
