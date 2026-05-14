/**
 * Stream Markers — renderer-safe re-export of checkpoint-detector utilities.
 *
 * The renderer (src/ui/renderer/) must NOT import directly from src/engine/
 * to preserve layering boundaries. This shim lives in src/lib/ — a shared
 * layer accessible to both main-process and renderer code — and re-exports
 * the pure text-processing helpers that are safe to call in the renderer.
 */
export { detectFromStream, type DetectorResult } from "../engine/checkpoint-detector.js";
