import { closeSync, fchmodSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../lib/atomic-file.js";

// Keep ownership until the OS process exits, including after a cleanup timeout.
let processLock: Database.Database | undefined;

/** A kernel-backed exclusive transaction survives event-loop pauses. */
export async function acquireHostInstanceLock(): Promise<void> {
  if (processLock) throw new Error("host-already-running");
  const namespace = openFeatureNamespace("host-runtime");
  const directory = await namespace.childDir(".");
  if (process.platform !== "win32" && (statSync(directory).mode & 0o777) !== PRIVATE_DIR_MODE) {
    throw new Error("host-ownership-directory-not-private");
  }
  const path = join(directory, "instance.sqlite");
  // SQLite's lifetime lock must keep this inode: replacing it with an atomic
  // writer would let a second host lock a different file at the same path.
  const descriptor = openSync(path, "a", PRIVATE_FILE_MODE);
  try {
    if (process.platform !== "win32") fchmodSync(descriptor, PRIVATE_FILE_MODE);
  } finally {
    closeSync(descriptor);
  }
  let database: Database.Database | undefined;
  try {
    database = new Database(path, { timeout: 0 });
    database.exec("BEGIN EXCLUSIVE");
    processLock = database;
  } catch (error) {
    database?.close();
    const code = (error as { code?: string }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      throw new Error("host-already-running", { cause: error });
    }
    throw error;
  }
}
