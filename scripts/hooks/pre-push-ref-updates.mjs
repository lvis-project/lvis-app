/**
 * Parsing of git's pre-push ref-update list.
 *
 * Split out of run-local-checks.mjs so it can be tested directly: that module
 * runs its checks at import, so importing it to exercise a pure function is
 * not possible. Sits beside the other pre-push-*.mjs policy modules.
 */
import { readFileSync } from "node:fs";

/**
 * Read git's ref-update list from stdin.
 *
 * Reports whether the read SUCCEEDED separately from what it produced. "git
 * sent an empty list" and "we could not read git's list" both look like an
 * empty string and must not be treated alike — see parsePrePushUpdates.
 */
export function readPrePushInput() {
  // A TTY on stdin means this was not invoked by git as a pre-push hook, so
  // there is no ref-update list to read — not an empty one.
  if (process.stdin.isTTY) return { readable: false, text: "" };
  try {
    return { readable: true, text: readFileSync(0, "utf-8") };
  } catch {
    return { readable: false, text: "" };
  }
}
/**
 * `complete` means every ref update git reported was understood, so a caller
 * enforcing branch policy is deciding on the real set.
 *
 * An input that could not be read is NOT complete — the caller must refuse. An
 * input that was read and is empty IS complete: git had no ref updates to
 * send, so the push changes no ref and cannot violate a branch policy.
 *
 * Conflating those two refused every re-run of an already-landed push with a
 * parse error. That reads as a failed push while the branch is in fact on the
 * remote at the right commit, which is a confusing way to learn there was
 * nothing left to do.
 */
export function parsePrePushUpdates({ readable, text }) {
  if (!readable) return { updates: [], complete: false };

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const updates = [];
  let complete = true;

  for (const line of lines) {
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      complete = false;
      continue;
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    const validObjectIds = [localSha, remoteSha].every((sha) =>
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)
    );
    if (!localRef || !remoteRef || !validObjectIds) {
      complete = false;
      continue;
    }
    updates.push({ localRef, localSha, remoteRef, remoteSha });
  }

  return { updates, complete: complete && updates.length === lines.length };
}
