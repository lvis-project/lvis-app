/**
 * The float→int16 conversion the capture window's frames go through.
 *
 * This lives on the main-process side precisely so it can be tested. The
 * failure it guards against — scaling positives by 32768 and wrapping the
 * loudest sample round to the quietest — is inaudible on a test tone and a
 * hard click on the loudest moment of a real recording, which is the kind of
 * bug that gets reported as "it glitches sometimes" and never reproduces.
 */
import { describe, expect, it } from "vitest";
import { floatToInt16LittleEndian } from "../audio-capture-surface.js";

/** Read the encoded bytes back as the int16 values they claim to be. */
function decode(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
}

describe("floatToInt16LittleEndian", () => {
  it("maps full scale to the endpoints without wrapping", () => {
    // THE case. `1.0` must land on +32767, not on -32768.
    expect(decode(floatToInt16LittleEndian(new Float32Array([1, -1, 0])))).toEqual([32767, -32768, 0]);
  });

  it("clamps out-of-range samples instead of letting them wrap", () => {
    // A sum of two loud sources can exceed 1.0. Wrapping would turn the
    // loudest part of the audio into its opposite.
    expect(decode(floatToInt16LittleEndian(new Float32Array([1.5, -1.5])))).toEqual([32767, -32768]);
  });

  it("writes little-endian, two bytes per sample", () => {
    const bytes = floatToInt16LittleEndian(new Float32Array([1]));
    expect(bytes.byteLength).toBe(2);
    // 32767 = 0x7FFF → low byte first.
    expect(Array.from(bytes)).toEqual([0xff, 0x7f]);
  });

  it("rounds rather than truncating toward zero", () => {
    // Truncation biases every sample toward silence, which over a whole
    // recording is a measurable DC-free but quieter signal.
    const [value] = decode(floatToInt16LittleEndian(new Float32Array([0.5])));
    expect(value).toBe(Math.round(0.5 * 0x7fff));
  });

  it("produces an empty buffer for no samples rather than throwing", () => {
    expect(floatToInt16LittleEndian(new Float32Array([])).byteLength).toBe(0);
  });
});
