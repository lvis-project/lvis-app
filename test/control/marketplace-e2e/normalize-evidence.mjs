import {
  chmod,
  chown,
  lstat,
  realpath,
  readdir,
} from "node:fs/promises";
import { resolve, sep } from "node:path";

if (process.getuid?.() !== 0) {
  throw new Error("pre-validation evidence normalization must run as trusted root");
}
const uid = Number(process.env.EXPORT_UID);
const gid = Number(process.env.EXPORT_GID);
if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
  throw new Error("runner UID/GID are invalid");
}
const root = "/evidence";
if (await realpath(root) !== root) throw new Error("evidence root traverses a symlink");
const rootStat = await lstat(root);
if (
  !rootStat.isDirectory()
  || rootStat.isSymbolicLink()
  || rootStat.uid !== 0
  || rootStat.gid !== 0
  || (rootStat.mode & 0o7777) !== 0o1733
) {
  throw new Error("evidence root is not the trusted root-owned sticky drop directory");
}
const expected = new Map([
  ["input-bindings.json", { uid: 0, gid: 0, mode: 0o444 }],
  ["control-harness-manifest.json", { uid: 0, gid: 0, mode: 0o444 }],
  ["image-digests.json", { uid: 0, gid: 0, mode: 0o444 }],
  ["input-contract.json", { uid: 0, gid: 0, mode: 0o444 }],
  ["host-lifecycle.json", { uid: 10001, gid: 10001, mode: 0o600 }],
  ["hostile-containment.json", { uid: 10002, gid: 10002, mode: 0o600 }],
  ["container-exits.json", { uid: 10003, gid: 10003, mode: 0o600 }],
]);
const names = await readdir(root);
if (names.length !== expected.size || names.some((name) => !expected.has(name))) {
  throw new Error("evidence volume has missing or unknown entries");
}
let total = 0;
for (const name of names) {
  const path = resolve(root, name);
  if (!path.startsWith(`${root}${sep}`) || await realpath(path) !== path) {
    throw new Error(`evidence path escaped its volume: ${name}`);
  }
  const stat = await lstat(path);
  const metadata = expected.get(name);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.uid !== metadata.uid
    || stat.gid !== metadata.gid
    || (stat.mode & 0o777) !== metadata.mode
    || stat.size <= 0
    || stat.size > 2 * 1024 * 1024
  ) {
    throw new Error(`unsafe pre-validation evidence entry or owner: ${name}`);
  }
  total += stat.size;
}
if (total > 5 * 1024 * 1024) throw new Error("evidence volume exceeds its size budget");
for (const name of names) {
  const path = resolve(root, name);
  await chown(path, uid, gid);
  await chmod(path, 0o600);
}
await chown(root, uid, gid);
await chmod(root, 0o700);
