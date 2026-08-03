import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createTailnetAttachmentStagingStore,
} from "../tailnet-attachment-staging-store.js";

const OWNER_ONE = createHash("sha256").update("owner-one").digest("hex");
const OWNER_TWO = createHash("sha256").update("owner-two").digest("hex");
const PNG = Buffer.from("iVBORw0KGgo=", "base64");

function ids() {
  let serial = 1;
  return () => `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`;
}

describe("TailnetAttachmentStagingStore", () => {
  it("stages a verified image for exactly one matching owner claim", () => {
    const store = createTailnetAttachmentStagingStore({ randomUuid: ids() });
    const staged = store.stage({
      ownerKey: OWNER_ONE,
      isCurrent: () => true,
      mimeType: "image/png",
      bytes: PNG,
    });

    expect(staged).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    expect(store.reserve(OWNER_TWO, [staged!.id])).toBeNull();

    const claim = store.reserve(OWNER_ONE, [staged!.id]);
    expect(claim?.attachments).toEqual([{
      type: "image",
      image: "data:image/png;base64,iVBORw0KGgo=",
      mimeType: "image/png",
    }]);
    expect(store.reserve(OWNER_ONE, [staged!.id])).toBeNull();

    store.commit(claim!);
    expect(store.reserve(OWNER_ONE, [staged!.id])).toBeNull();
  });

  it("drops staged images when their paired binding expires or is revoked", () => {
    let now = 10;
    let current = true;
    const store = createTailnetAttachmentStagingStore({
      randomUuid: ids(),
      now: () => now,
      ttlMs: 100,
    });
    const staged = store.stage({
      ownerKey: OWNER_ONE,
      isCurrent: () => current,
      mimeType: "image/png",
      bytes: PNG,
    });

    current = false;
    store.discardStale();
    expect(store.reserve(OWNER_ONE, [staged!.id])).toBeNull();

    current = true;
    const fresh = store.stage({
      ownerKey: OWNER_ONE,
      isCurrent: () => current,
      mimeType: "image/png",
      bytes: PNG,
    });
    now += 101;
    expect(store.reserve(OWNER_ONE, [fresh!.id])).toBeNull();
  });

  it("fails closed for MIME spoofing, duplicate ids, and per-owner capacity", () => {
    const store = createTailnetAttachmentStagingStore({ randomUuid: ids() });
    expect(store.stage({
      ownerKey: OWNER_ONE,
      isCurrent: () => true,
      mimeType: "image/jpeg",
      bytes: PNG,
    })).toBeNull();

    const staged = Array.from({ length: 5 }, () => store.stage({
      ownerKey: OWNER_ONE,
      isCurrent: () => true,
      mimeType: "image/png",
      bytes: PNG,
    }));
    expect(staged.every(Boolean)).toBe(true);
    expect(store.stage({
      ownerKey: OWNER_ONE,
      isCurrent: () => true,
      mimeType: "image/png",
      bytes: PNG,
    })).toBeNull();
    expect(store.reserve(OWNER_ONE, [staged[0]!.id, staged[0]!.id])).toBeNull();
  });
});
