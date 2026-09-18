import { isAbsolute } from "node:path";
import {
  ImagePreparationBytesRequestSchema,
  ImagePreparationRequestSchema,
} from "../shared/image-preparation-policy.js";
import { normalizeImage } from "./image-preparation-core.js";
import { errorMessage } from "../shared/error-message.js";
import { readImageInput } from "./image-preparation-input.js";
import { ensureFileAccess } from "./file-access-policy.js";

async function readBoundedStdin(expectedBytes: number): Promise<Buffer> {
  // Allocate the declared bounded size once. Collecting chunks and then using
  // Buffer.concat would briefly double the largest allowed source allocation.
  const input = Buffer.allocUnsafe(expectedBytes);
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.byteLength > expectedBytes - total) {
      throw new Error("image-input-limit: Decoder stdin exceeds its declared byte budget.");
    }
    bytes.copy(input, total);
    total += bytes.byteLength;
  }
  if (total !== expectedBytes) {
    throw new Error(`invalid-image: Decoder stdin length mismatch (expected ${expectedBytes}, received ${total}).`);
  }
  return input;
}

try {
  const raw: unknown = JSON.parse(process.argv[2] ?? "{}");
  const bytesRequest = ImagePreparationBytesRequestSchema.safeParse(raw);
  if (bytesRequest.success) {
    const bytes = await readBoundedStdin(bytesRequest.data.inputBytes);
    process.stdout.write(JSON.stringify({
      ok: true,
      image: await normalizeImage(bytes, bytesRequest.data.options),
    }));
  } else {
    const request = ImagePreparationRequestSchema.parse(raw);
    if (!isAbsolute(request.path) || !isAbsolute(request.scope.cwd)) throw new Error("invalid-image-path: Image source and read scope must be absolute.");
    // Repeat the existing file policy after admission, immediately before opening.
    // The parent owns approval; this cannot broaden the invocation's read scope.
    const denied = ensureFileAccess(request.path, { ...request.scope, metadata: {} }, "read");
    if (denied) throw new Error(denied.output);
    const bytes = await readImageInput(request.path, new AbortController().signal);
    process.stdout.write(JSON.stringify({ ok: true, image: await normalizeImage(bytes, request.options) }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: `invalid-image: ${errorMessage(error).slice(0, 2048)}` }));
  process.exitCode = 1;
}
