import type { PluginInstallResultPayload } from "../contract/app-contract.js";
import {
  IncompatibleAppVersionError,
  INCOMPATIBLE_APP_VERSION_CODE,
} from "../plugins/public-contract.js";

/**
 * Producer for the `plugins.installResult` failure payload. Sole constructor of
 * the shape, so the code/message pairing cannot drift between the install
 * handler and the dev local-install handler.
 *
 * A recognised failure sends its stable English code in `error` and keeps the
 * concrete English text (which carries the version numbers) in `message`.
 * `formatIpcError(error, message)` on the renderer turns that pair into
 * localized copy; an unrecognised failure has no code, so the plain message
 * goes in `error` and the renderer's fallback surfaces it verbatim.
 *
 * This lives outside `public-contract.ts` deliberately: that module is copied
 * mechanically into the SDK and must stay import-free.
 */
export function buildInstallFailureResult(
  slug: string,
  error: unknown,
  fallbackMessage: string,
): PluginInstallResultPayload {
  const message = (error instanceof Error ? error.message : "") || fallbackMessage;
  const code = error instanceof IncompatibleAppVersionError
    ? INCOMPATIBLE_APP_VERSION_CODE
    : undefined;
  return {
    slug,
    success: false,
    error: code ?? message,
    ...(code ? { message } : {}),
  };
}
