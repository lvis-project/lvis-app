import assert from "node:assert/strict";
import test from "node:test";
import {
  HEADLESS_PACKAGED_MARKER_NAME,
  headlessPackagedMarkerPath,
  readHeadlessPackagedMarker,
} from "../../scripts/lib/headless-packaged-marker.mjs";

test("uses one versioned marker path", () => {
  assert.equal(HEADLESS_PACKAGED_MARKER_NAME, ".lvis-headless-packaged-v1");
  assert.equal(headlessPackagedMarkerPath("/app"), "/app/.lvis-headless-packaged-v1");
});

test("propagates unexpected marker inspection failures as a closed startup", () => {
  const cause = new Error("permission denied");
  assert.throws(
    () => readHeadlessPackagedMarker("/app", () => { throw cause; }),
    (error) => error instanceof Error
      && error.message === "Packaged runtime marker inspection failed: /app/.lvis-headless-packaged-v1"
      && error.cause === cause,
  );
});
