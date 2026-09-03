/**
 * `lvis:home-docs:*` — the `~/.lvis` reference docs and their pending packaged
 * updates, as something the user can act on.
 *
 * The seeder has always left a `<file>.new` marker beside a doc the user
 * edited, and boot has always fired one notification about it. Nothing read
 * those markers back, so the only way to answer one was to open the directory
 * and diff two files by hand. These handlers are that answer: read the offer,
 * take it, keep your own, or have the model combine the two.
 *
 * Only `AGENTS.md` accepts an action. Markers for skills and prompts are
 * listed so the user can see they exist; acting on one is a different decision
 * (a skill is loaded on demand, not composed into every turn) and it is not
 * made here by accident.
 */
import { ipcMain } from "electron";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import {
  discardLvisHomeDocUpgradeMarker,
  isShippedAgentsMdContent,
  listLvisHomeDocUpgradeMarkers,
  readLvisHomeDocSource,
  readLvisHomeDocUpgradeMarker,
  retireAppliedLvisHomeDocUpgradeMarkers,
} from "../../main/seed-lvis-home-docs.js";
import {
  AGENTS_CUSTOM_DOC_NAME,
  AGENTS_DOC_NAME,
} from "../../shared/lvis-home.js";
import { errorMessage } from "../../shared/error-message.js";
import { createLogger } from "../../lib/logger.js";
import type { IpcDeps } from "../types.js";
import type { AuditLogger } from "../../audit/audit-logger.js";

const log = createLogger("home-docs-ipc");

/** How a `~/.lvis` path is spelled for the user, on every platform. */
function displayPath(relativePath: string): string {
  return `~/.lvis/${relativePath.split("\\").join("/")}`;
}

interface HomeDocUpgradeMarkerView {
  /** Path relative to `~/.lvis`, and the handle every action takes. */
  markerPath: string;
  /** The live doc this offer would replace, relative to `~/.lvis`. */
  sourcePath: string;
  markerDisplayPath: string;
  sourceDisplayPath: string;
  /** Whether this marker's actions are wired. Only the agent context's are. */
  actionable: boolean;
}

export interface HomeDocsStatus {
  agentsDisplayPath: string;
  customDisplayPath: string;
  markers: HomeDocUpgradeMarkerView[];
  /** A merge waiting for review, or `null`. Survives an app restart. */
  mergedContent: string | null;
}

function auditHomeDocs(auditLogger: AuditLogger, detail: Record<string, unknown>): void {
  auditLogger.log({
    timestamp: new Date().toISOString(),
    sessionId: "home-docs",
    type: "info",
    input: JSON.stringify(detail),
  });
}

export function registerHomeDocsHandlers(deps: IpcDeps): void {
  const { auditLogger, memoryManager, settingsService } = deps;

  const keepLatest = (): boolean => settingsService.get("homeDocs").keepLatest;

  ipcMain.handle(CHANNELS.homeDocs.upgradeMarkersList, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.upgradeMarkersList, event);
      return UNAUTHORIZED_FRAME;
    }
    // Re-scanned rather than read off the boot snapshot: the user may have
    // answered several offers since launch, and a stale list would let them
    // apply a marker that is already gone.
    const status: HomeDocsStatus = {
      agentsDisplayPath: displayPath(AGENTS_DOC_NAME),
      customDisplayPath: displayPath(AGENTS_CUSTOM_DOC_NAME),
      markers: listLvisHomeDocUpgradeMarkers().map((marker) => ({
        markerPath: marker.markerPath,
        sourcePath: marker.sourcePath,
        markerDisplayPath: displayPath(marker.markerPath),
        sourceDisplayPath: displayPath(marker.sourcePath),
        actionable: marker.sourcePath === AGENTS_DOC_NAME,
      })),
      mergedContent: deps.agentsDocMergeService?.readMerged() ?? null,
    };
    return status;
  });

  ipcMain.handle(CHANNELS.homeDocs.markerRead, (event, markerPath: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.markerRead, event);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof markerPath !== "string") {
      return { ok: false, error: "invalid-marker-path" } as const;
    }
    const content = readLvisHomeDocUpgradeMarker(markerPath);
    if (content === null) return { ok: false, error: "unknown-upgrade-marker" } as const;
    return {
      ok: true,
      content,
      live: readLvisHomeDocSource(markerPath) ?? "",
    } as const;
  });

  ipcMain.handle(CHANNELS.homeDocs.packagedApply, async (event, markerPath: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.packagedApply, event);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof markerPath !== "string") {
      return { ok: false, error: "invalid-marker-path" } as const;
    }
    const marker = listLvisHomeDocUpgradeMarkers().find((m) => m.markerPath === markerPath);
    if (!marker) return { ok: false, error: "unknown-upgrade-marker" } as const;
    if (marker.sourcePath !== AGENTS_DOC_NAME) {
      return { ok: false, error: "unsupported-upgrade-target" } as const;
    }
    const content = readLvisHomeDocUpgradeMarker(markerPath);
    if (content === null) return { ok: false, error: "unknown-upgrade-marker" } as const;

    try {
      // Keep-latest is what makes this replacement safe to perform at all: the
      // user's own sentences move to `agents.custom.md` first and the prompt
      // keeps reading them. Bytes this app shipped are not their content, so
      // moving those would hand the model the same reference twice with one
      // copy mislabelled as the user's own instruction.
      const current = memoryManager.getAgentsMd();
      const movedToCustom =
        keepLatest() && current.trim().length > 0 && !isShippedAgentsMdContent(current);
      if (movedToCustom) {
        await memoryManager.updateAgentsCustomMd(current);
      }
      await memoryManager.updateAgentsMd(content);
      retireAppliedLvisHomeDocUpgradeMarkers(markerPath, content);
      auditHomeDocs(auditLogger, {
        action: "apply-packaged",
        markerPath,
        keepLatest: keepLatest(),
        movedToCustom,
      });
      return { ok: true, movedToCustom } as const;
    } catch (err) {
      log.warn("apply packaged doc failed: %s", errorMessage(err));
      return { ok: false, error: "home-doc-apply-failed" } as const;
    }
  });

  ipcMain.handle(CHANNELS.homeDocs.markerKeepMine, (event, markerPath: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.markerKeepMine, event);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof markerPath !== "string") {
      return { ok: false, error: "invalid-marker-path" } as const;
    }
    const removed = discardLvisHomeDocUpgradeMarker(markerPath);
    if (!removed) return { ok: false, error: "unknown-upgrade-marker" } as const;
    auditHomeDocs(auditLogger, { action: "keep-mine", markerPath });
    return { ok: true } as const;
  });

  ipcMain.handle(CHANNELS.homeDocs.customGet, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.customGet, event);
      return UNAUTHORIZED_FRAME;
    }
    return memoryManager.getAgentsCustomMd();
  });

  ipcMain.handle(CHANNELS.homeDocs.customUpdate, async (event, content: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.customUpdate, event);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof content !== "string") {
      return { ok: false, error: "invalid-content" } as const;
    }
    await memoryManager.updateAgentsCustomMd(content);
    return { ok: true } as const;
  });

  ipcMain.handle(CHANNELS.homeDocs.mergeRun, async (event, markerPath: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.mergeRun, event);
      return UNAUTHORIZED_FRAME;
    }
    const mergeService = deps.agentsDocMergeService;
    if (!mergeService) return { ok: false, error: "agents-doc-merge-unavailable" } as const;
    if (markerPath !== undefined && typeof markerPath !== "string") {
      return { ok: false, error: "invalid-marker-path" } as const;
    }

    // What the merge is BETWEEN depends on where the user's content currently
    // lives. Under keep-latest it is `agents.custom.md` against the packaged
    // doc; without it, the user's edits are the live doc itself, so a merge
    // only means something when a marker offers a newer version to merge with.
    const packaged = typeof markerPath === "string"
      ? readLvisHomeDocUpgradeMarker(markerPath)
      : memoryManager.getAgentsMd();
    if (packaged === null) return { ok: false, error: "unknown-upgrade-marker" } as const;
    const custom = keepLatest()
      ? memoryManager.getAgentsCustomMd()
      : memoryManager.getAgentsMd();
    if (custom.trim().length === 0 || (packaged === custom)) {
      return { ok: false, error: "nothing-to-merge" } as const;
    }

    try {
      const result = await mergeService.merge({ packaged, custom });
      auditHomeDocs(auditLogger, {
        action: "merge",
        ...(typeof markerPath === "string" ? { markerPath } : {}),
        keepLatest: keepLatest(),
        sources: result.sources,
      });
      return {
        ok: true,
        content: result.content,
        mergedAt: result.mergedAt,
        sources: result.sources,
      } as const;
    } catch (err) {
      // Provider and source detail is host-only; the renderer gets a stable code.
      log.warn("agent-context merge failed: %s", errorMessage(err));
      return { ok: false, error: "agents-doc-merge-failed" } as const;
    }
  });

  ipcMain.handle(CHANNELS.homeDocs.mergeApply, async (event, expectedContent: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.mergeApply, event);
      return UNAUTHORIZED_FRAME;
    }
    const mergeService = deps.agentsDocMergeService;
    if (!mergeService) return { ok: false, error: "agents-doc-merge-unavailable" } as const;
    if (typeof expectedContent !== "string") {
      return { ok: false, error: "invalid-content" } as const;
    }
    const merged = mergeService.readMerged();
    if (merged === null) return { ok: false, error: "no-merge-artifact" } as const;

    // Compare-and-swap against what the caller last saw, the same guard the
    // memory-index editor uses: the merge waited on a provider call, and an
    // edit that landed during that wait must not vanish under the answer.
    const applied = keepLatest()
      ? await memoryManager.updateAgentsCustomMdIfUnchanged(expectedContent, merged)
      : await memoryManager.updateAgentsMdIfUnchanged(expectedContent, merged);
    if (!applied) return { ok: false, error: "agents-doc-changed" } as const;

    mergeService.discardMerged();
    auditHomeDocs(auditLogger, { action: "apply-merged", keepLatest: keepLatest() });
    return { ok: true } as const;
  });

  ipcMain.handle(CHANNELS.homeDocs.mergeDiscard, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.mergeDiscard, event);
      return UNAUTHORIZED_FRAME;
    }
    deps.agentsDocMergeService?.discardMerged();
    return { ok: true } as const;
  });
}
