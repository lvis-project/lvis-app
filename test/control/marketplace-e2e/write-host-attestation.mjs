import { writeFile } from "node:fs/promises";

if (process.getuid?.() !== 10003) {
  throw new Error("Host attestation must run as the trusted evidence UID");
}

const exactSha = /^[0-9a-f]{40}$/;
const exactImage = /^sha256:[0-9a-f]{64}$/;
const refs = {
  host: process.env.HOST_SHA,
  marketplace: process.env.MARKETPLACE_SHA,
  sdk: process.env.SDK_SHA,
  epApi: process.env.EP_API_SHA,
  control: process.env.CONTROL_SHA,
};
for (const [name, value] of Object.entries(refs)) {
  if (!exactSha.test(value ?? "")) {
    throw new Error(`${name} attestation ref is not an exact commit SHA`);
  }
}
const images = {
  host: process.env.HOST_IMAGE,
  marketplace: process.env.MARKETPLACE_IMAGE,
};
if (!exactImage.test(images.host ?? "") || !exactImage.test(images.marketplace ?? "")) {
  throw new Error("Host attestation image IDs are invalid");
}
if (process.env.HOST_EXIT !== "0") {
  throw new Error("Host attestation requires a verified zero Host exit");
}

const payload = {
  schemaVersion: 1,
  refs,
  images,
  hostExit: 0,
  phases: {
    harnessIntegrity: true,
    trustedDependencyClosure: true,
    marketplaceTransport: true,
    marketplaceLifecycle: true,
    attendanceReadWriteReadback: true,
    reverseContainment: true,
  },
};
await writeFile(
  "/evidence/host-attestation.json",
  `${JSON.stringify(payload, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
