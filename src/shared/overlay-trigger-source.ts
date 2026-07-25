/**
 * Overlay trigger source naming.
 *
 * The `overlay:*` tag shape belongs to the PLUGIN row of the staged-origin table
 * (`shared/staged-origins.ts`), which also owns that origin's envelope, its
 * force-ask membership, and its model-facing guidance. This module re-exports the
 * pattern under the name the trigger-spec validator already uses, so the gate that
 * rejects a malformed `source` and the parser that reads provenance out of the
 * envelope can never disagree about what `overlay:*` means.
 *
 * The envelope tag itself is still spelled `imported-from-proactive` because
 * plugins may already author that wrapper.
 */
import { stagedOriginForInput } from "./staged-origins.js";

const OVERLAY_KIND = stagedOriginForInput("plugin-emitted")!;

/**
 * Strict `overlay:<name>` shape — rejects "overlay:", "overlay:_x",
 * "overlay:Bad/Path". Fail-closed: a non-matching source is never enveloped.
 */
export const OVERLAY_TRIGGER_SOURCE_PATTERN = OVERLAY_KIND.sourcePattern;
