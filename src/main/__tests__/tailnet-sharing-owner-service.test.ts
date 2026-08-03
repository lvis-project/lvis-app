import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretStore } from "../../audit/hmac-chain.js";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { createTailnetPairedSharingRuntime } from "../tailnet-paired-sharing-runtime.js";
import { createTailnetSharingOwnerService } from "../tailnet-sharing-owner-service.js";

let directories: string[] = [];

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

function namespace(directory: string): FeatureNamespaceHandle {
  return {
    get dir(): string {
      return directory;
    },
    async readJson<T>(_name: string, fallback: T): Promise<T> {
      return fallback;
    },
    async writeJson<T>(name: string, value: T): Promise<void> {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, name), JSON.stringify(value), "utf8");
    },
    async childDir(name: string): Promise<string> {
      const child = join(directory, name);
      mkdirSync(child, { recursive: true, mode: 0o700 });
      return child;
    },
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lvis-tailnet-owner-"));
  directories.push(directory);
  const now = { value: 1_000_000 };
  const current = { id: "private-conversation-a" };
  const runtime = await createTailnetPairedSharingRuntime({
    getCurrentConversationId: () => current.id,
    secretStore: new MemorySecretStore(),
    storeOptions: {
      namespace: namespace(directory),
      now: () => now.value,
    },
  });
  return {
    current,
    runtime,
    owner: createTailnetSharingOwnerService({
      runtime,
      getCurrentConversationId: () => current.id,
    }),
  };
}

describe("TailnetSharingOwnerService", () => {
  it("shows only a safe owner projection and creates a share for the live conversation", async () => {
    const f = await fixture();
    const invitation = await f.owner.createInvitation("10m");
    expect(invitation.expiresAt).toBe(1_600_000);
    expect(f.owner.snapshot()).toEqual({
      invitations: [{ id: invitation.id, expiresAt: invitation.expiresAt }],
      pairings: [],
      shares: [],
    });

    const actor = f.runtime.authorizer.actorIdFor("remote-owner@example.test");
    expect(actor).not.toBeNull();
    const claim = await f.runtime.store.claimInvitation(invitation.code, actor!);
    expect(claim).not.toBeNull();
    expect(JSON.stringify(f.owner.snapshot()))
      .not.toContain("remote-owner@example.test");
    expect(JSON.stringify(f.owner.snapshot()))
      .not.toContain(invitation.code);
    expect(JSON.stringify(f.owner.snapshot()))
      .not.toContain("private-conversation-a");

    expect(await f.owner.activatePairing(claim!.pairingId)).toBe(true);
    expect(await f.owner.createCurrentConversationShare(claim!.pairingId, "control", "1h")).toBe(true);
    expect(f.runtime.store.resolveActiveShare(actor!, "private-conversation-a", "control"))
      .not.toBeNull();

    f.current.id = "private-conversation-b";
    expect(await f.owner.createCurrentConversationShare(claim!.pairingId, "observe", "8h")).toBe(true);
    expect(f.runtime.store.resolveActiveShare(actor!, "private-conversation-b", "observe"))
      .not.toBeNull();
    expect(f.runtime.store.resolveActiveShare(actor!, "private-conversation-b", "control"))
      .toBeNull();
  });

  it("fails closed for malformed owner inputs and emits store change hints after durable mutations", async () => {
    const f = await fixture();
    let changes = 0;
    const unsubscribe = f.owner.subscribe(() => {
      changes += 1;
    });

    await expect(f.owner.createInvitation("bad" as never))
      .rejects.toThrow("tailnet-sharing-owner-input-invalid");
    expect(await f.owner.activatePairing("not-a-uuid")).toBe(false);
    expect(await f.owner.createCurrentConversationShare("not-a-uuid", "observe")).toBe(false);
    expect(await f.owner.revokeShare("not-a-uuid")).toBe(false);
    expect(await f.owner.revokePairing("not-a-uuid")).toBe(false);

    const invitation = await f.owner.createInvitation();
    expect(changes).toBe(1);
    const actor = f.runtime.authorizer.actorIdFor("remote-owner@example.test")!;
    const claim = await f.runtime.store.claimInvitation(invitation.code, actor);
    expect(claim).not.toBeNull();
    expect(await f.owner.activatePairing(claim!.pairingId)).toBe(true);
    expect(await f.owner.createCurrentConversationShare(claim!.pairingId, "observe")).toBe(true);
    expect(await f.owner.revokePairing(claim!.pairingId)).toBe(true);
    unsubscribe();

    expect(changes).toBe(5);
    expect(f.runtime.store.resolveActiveShare(actor, "private-conversation-a", "observe")).toBeNull();
  });
});
