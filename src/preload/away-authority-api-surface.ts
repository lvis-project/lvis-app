/**
 * Narrow host-renderer bridge for arming the desk-armed away answerer.
 *
 * A leaf like the other owner surfaces: plugin frames and public/external
 * surfaces do not receive it. Both mutations mint their own live keyboard
 * intent here rather than accepting one from the caller, so a renderer cannot
 * replay or fabricate the gesture that arms an answerer.
 */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseAwayAuthorityMutationResult,
  parseAwayAuthorityStatusResult,
  type AwayAuthorityBudgetPreset,
  type AwayAuthorityDurationPreset,
  type AwayAuthorityMode,
  type AwayAuthorityMutationResult,
  type AwayAuthorityOwnerApi,
  type AwayAuthorityStatusResult,
} from "../shared/away-authority-arm.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";

function unavailableMutation(): AwayAuthorityMutationResult {
  return Object.freeze({ ok: false, error: "away-authority-unavailable" });
}

function unavailableStatus(): AwayAuthorityStatusResult {
  return Object.freeze({ ok: false, error: "away-authority-unavailable" });
}

async function invokeMutation(
  channel: string,
  payload: unknown,
): Promise<AwayAuthorityMutationResult> {
  try {
    return parseAwayAuthorityMutationResult(await ipcRenderer.invoke(channel, payload))
      ?? unavailableMutation();
  } catch {
    return unavailableMutation();
  }
}

/** Build the private `window.lvisApi.awayAuthority` namespace. */
export function buildAwayAuthorityApiSurface(): AwayAuthorityOwnerApi {
  return Object.freeze({
    async status(): Promise<AwayAuthorityStatusResult> {
      try {
        return parseAwayAuthorityStatusResult(
          await ipcRenderer.invoke(CHANNELS.awayAuthority.status),
        ) ?? unavailableStatus();
      } catch {
        return unavailableStatus();
      }
    },

    arm(input: {
      mode: AwayAuthorityMode;
      directories: readonly string[];
      duration: AwayAuthorityDurationPreset;
      budget: AwayAuthorityBudgetPreset;
    }): Promise<AwayAuthorityMutationResult> {
      return invokeMutation(CHANNELS.awayAuthority.arm, {
        mode: input.mode,
        // Rebuilt rather than forwarded: the array crosses a context bridge and
        // main's shape guard demands exact keys, so a caller's exotic array
        // subclass or extra properties must not travel with it.
        directories: [...input.directories],
        duration: input.duration,
        budget: input.budget,
        intent: ipcUserKeyboardIntent(),
      });
    },

    disarm(): Promise<AwayAuthorityMutationResult> {
      return invokeMutation(CHANNELS.awayAuthority.disarm, {
        intent: ipcUserKeyboardIntent(),
      });
    },
  });
}
