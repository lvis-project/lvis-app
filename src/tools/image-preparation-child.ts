import { isAbsolute } from "node:path";
import { ImagePreparationRequestSchema } from "../shared/image-preparation-policy.js";
import { normalizeImage } from "./image-preparation-core.js";
import { errorMessage } from "../shared/error-message.js";
import { readImageInput } from "./image-preparation-input.js";
import { ensureFileAccess } from "./file-access-policy.js";

try {
  const request = ImagePreparationRequestSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
  if (!isAbsolute(request.path) || !isAbsolute(request.scope.cwd)) throw new Error("invalid-image-path: Image source and read scope must be absolute.");
  // Repeat the existing file policy after admission, immediately before opening.
  // The parent owns approval; this cannot broaden the invocation's read scope.
  const denied = ensureFileAccess(request.path, { ...request.scope, metadata: {} }, "read");
  if (denied) throw new Error(denied.output);
  const bytes = await readImageInput(request.path, new AbortController().signal);
  process.stdout.write(JSON.stringify({ ok: true, image: await normalizeImage(bytes, request.options) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: `invalid-image: ${errorMessage(error).slice(0, 2048)}` }));
  process.exitCode = 1;
}
