import { writeFile } from "node:fs/promises";

const exactImage = /^sha256:[0-9a-f]{64}$/;
const payload = {
  host: Number(process.env.HOST_EXIT),
  marketplace: Number(process.env.MARKETPLACE_EXIT),
  hostile: Number(process.env.HOSTILE_EXIT),
  hostImage: process.env.HOST_IMAGE,
  marketplaceImage: process.env.MARKETPLACE_IMAGE,
};
if (
  payload.host !== 0
  || payload.marketplace !== 0
  || payload.hostile !== 0
  || !exactImage.test(payload.hostImage ?? "")
  || !exactImage.test(payload.marketplaceImage ?? "")
) {
  throw new Error("container exits are not zero or image IDs are invalid");
}
await writeFile(
  "/evidence/container-exits.json",
  `${JSON.stringify(payload, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
