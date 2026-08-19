/**
 * The two-sided lifetime, exercised for every way it can end.
 *
 * A subscription leak is the failure mode with no symptom: nothing throws,
 * nothing fails, memory grows, and a retired plugin's callbacks keep firing.
 * So the assertions here are on the COUNTS on both sides, not on behaviour that
 * happens to still work.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DuplicateSubscriptionError,
  SubscriptionLedger,
  SubscriptionLedgerEndedError,
} from "../subscription-ledger.js";

describe("SubscriptionLedger", () => {
  it("runs a release exactly once, however many times it is closed", () => {
    const release = vi.fn();
    const ledger = new SubscriptionLedger<string>("test");
    const id = ledger.open("a", release);

    expect(ledger.close(id, "disposed")).toBe(true);
    expect(ledger.close(id, "disposed")).toBe(false);
    expect(ledger.close(id, "peer-gone")).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("a", "disposed", id);
    expect(ledger.openCount).toBe(0);
  });

  it("survives a release that disposes itself", () => {
    const ledger = new SubscriptionLedger<string>("test");
    let reentered = 0;
    const id = ledger.open("a", () => {
      reentered += 1;
      // A plugin disposer that calls itself is not exotic; a ledger that ran
      // the release again here would double-release for real.
      ledger.close(id, "disposed");
    });
    ledger.close(id, "disposed");
    expect(reentered).toBe(1);
    expect(ledger.openCount).toBe(0);
  });

  it("tells the release WHY, so it can decide whether to notify the peer", () => {
    const reasons: string[] = [];
    const ledger = new SubscriptionLedger<string>("test");
    ledger.adopt("s1", "a", (_v, reason) => reasons.push(reason));
    ledger.adopt("s2", "b", (_v, reason) => reasons.push(reason));
    ledger.close("s1", "revoked");
    ledger.end("peer-gone");
    expect(reasons).toEqual(["revoked", "peer-gone"]);
  });

  it("refuses a duplicate id instead of overwriting a release", () => {
    const ledger = new SubscriptionLedger<string>("test");
    const first = vi.fn();
    ledger.adopt("s1", "a", first);
    expect(() => ledger.adopt("s1", "b", vi.fn())).toThrow(DuplicateSubscriptionError);
    ledger.close("s1", "disposed");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("refuses to open once the peer is gone", () => {
    const ledger = new SubscriptionLedger<string>("test");
    ledger.end("peer-gone");
    expect(ledger.isEnded).toBe(true);
    expect(() => ledger.open("a", vi.fn())).toThrow(SubscriptionLedgerEndedError);
  });

  it("releases every registration when the peer dies, and reports how many", () => {
    const released: string[] = [];
    const ledger = new SubscriptionLedger<string>("test");
    for (const value of ["a", "b", "c"]) {
      ledger.open(value, (v) => released.push(v));
    }
    expect(ledger.end("peer-gone")).toBe(3);
    expect(released.sort()).toEqual(["a", "b", "c"]);
    expect(ledger.openCount).toBe(0);
  });

  it("ends cleanly when one release closes a sibling", () => {
    const ledger = new SubscriptionLedger<string>("test");
    const released: string[] = [];
    const first = ledger.open("a", (v) => {
      released.push(v);
      ledger.close(second, "peer-gone");
    });
    const second = ledger.open("b", (v) => released.push(v));
    expect(first).not.toBe(second);
    // Two registrations, two releases, no double-run — the count reports the
    // ones `end` itself closed, and the sibling it closed is not counted twice.
    expect(ledger.end("peer-gone")).toBe(1);
    expect(released).toEqual(["a", "b"]);
    expect(ledger.openCount).toBe(0);
  });
});
