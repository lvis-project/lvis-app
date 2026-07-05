import { useState } from "react";
import { ChevronDown, Folder, FolderPlus } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { useTranslation } from "../../../i18n/react.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import { projectRootEquals } from "../../../shared/project-identity.js";
import { useAddProjectFolder, addedRootDisplayName } from "../hooks/use-add-project-folder.js";

export interface ComposerProjectSelectorProps {
  /** Currently active project — drives the trigger label. */
  activeProject?: ProjectIdentity;
  /** Full known project list — the SAME source the sidebar's project group
   *  renders from (App-level `workspaceProjects`), so this selector never
   *  drifts from the sidebar's list. */
  projects: ProjectIdentity[];
  /** Switch the active project — the SAME handler wired to the sidebar's
   *  project rows (`onNewChatForProject`), so selecting here behaves
   *  identically to clicking a project in the sidebar. */
  onSelectProject: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  /** Re-fetch the workspace project list after a folder is added — the same
   *  refresh App.tsx already exposes to the sidebar's context menu. */
  onRefreshProjects?: () => void | Promise<void>;
  /** Controls the dropdown's open state so the caller (ChatComposerDock) can
   *  force-close it when the composer transitions off the centered layout
   *  (first message sent) — see the close-animation requirement. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Empty-state composer project selector — a small "📁 <project name> ⌄"
 * trigger attached directly above the composer card, opening a DOWNWARD
 * dropdown (side="bottom") that lists known projects + "add new project".
 * Mirrors the antigravity-style reference: the trigger sits in the same
 * reserved toast-zone the composer dock already carries (see
 * `composer-toast-dock`), and the panel opens over the composer area below it
 * rather than upward, since the centered composer sits in the screen's
 * vertical middle with limited headroom above.
 *
 * Data/actions are NOT reimplemented here — `projects` / `onSelectProject` /
 * `onRefreshProjects` are the exact same App-level state + handlers the
 * Sidebar's project rows and context menu already use, so switching or adding
 * a project from the composer is byte-identical in effect to doing it from
 * the sidebar (single SOT, no duplicated project-mutation logic).
 */
export function ComposerProjectSelector({
  activeProject,
  projects,
  onSelectProject,
  onRefreshProjects,
  open,
  onOpenChange,
}: ComposerProjectSelectorProps) {
  const { t } = useTranslation();
  const { pendingWarning, addFolder, confirmPendingFolder, cancelPendingFolder } = useAddProjectFolder();
  const [busy, setBusy] = useState(false);

  // The default/base-directory binding is never a "selected project" for
  // display purposes — only an explicit (non-default) project counts.
  // Matches antigravity/Claude Code/Codex convention: an imperative "Select
  // project" CTA until the user actually picks one; the real directory name
  // only appears once chosen. The default binding itself is untouched
  // internally (still used for tool/file access) — this is display-only.
  const hasRealSelection = Boolean(activeProject && activeProject.isDefault !== true);
  const label = hasRealSelection ? activeProject!.projectName : t("composerProjectSelector.selectProjectPlaceholder");
  // The default binding is not a pickable list entry — the dropdown only
  // offers real, user-added projects (+ "Add new project").
  const namedProjects = projects.filter((project) => project.isDefault !== true);

  const handleSelect = (project: ProjectIdentity) => {
    onOpenChange(false);
    void onSelectProject({
      ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
      projectName: project.projectName,
    });
  };

  const handleAddProject = async () => {
    setBusy(true);
    try {
      const result = await addFolder();
      if (!result) return; // canceled, failed, or awaiting ack (pendingWarning renders below)
      await onRefreshProjects?.();
      const addedRoot = result.added ?? result.roots.find((r) => !r.isDefault)?.path;
      if (addedRoot) {
        onOpenChange(false);
        void onSelectProject({ projectRoot: addedRoot, projectName: addedRootDisplayName(addedRoot) });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPending = async () => {
    setBusy(true);
    try {
      const result = await confirmPendingFolder();
      if (!result) return;
      await onRefreshProjects?.();
      const addedRoot = result.added ?? result.roots.find((r) => !r.isDefault)?.path;
      if (addedRoot) {
        onOpenChange(false);
        void onSelectProject({ projectRoot: addedRoot, projectName: addedRootDisplayName(addedRoot) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 rounded-full px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("composerProjectSelector.triggerAriaLabel")}
          data-testid="composer-project-selector-trigger"
          data-selected={hasRealSelection ? "true" : "false"}
        >
          <Folder className={`h-3 w-3 shrink-0 ${hasRealSelection ? "text-primary" : "text-muted-foreground"}`} />
          <span
            className={[
              "max-w-[12rem] truncate",
              hasRealSelection ? "text-foreground" : "italic text-muted-foreground",
            ].join(" ")}
          >
            {label}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      {/* side="bottom" — the panel opens DOWNWARD over the composer area below
          the trigger (not upward), matching the reference behavior for a
          centered composer with limited headroom. avoidCollisions off: we
          WANT it to overlay the composer, not flip to avoid it.
          forceMount + data-state transition: Radix keeps the panel mounted
          through its close so the fade/scale-out actually plays instead of
          the content vanishing instantly — this is what lets the dropdown
          close gracefully in step with the composer's descent (ChatView
          force-closes `open` the moment the centered layout ends; this
          transition is what makes that visible instead of an abrupt cut). */}
      <DropdownMenuContent
        side="bottom"
        align="start"
        avoidCollisions={false}
        sideOffset={6}
        forceMount
        className="w-64 origin-top transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0 data-[state=closed]:scale-95 data-[state=open]:opacity-100 data-[state=open]:scale-100"
        data-testid="composer-project-selector-menu"
      >
        {namedProjects.length > 0 ? (
          <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("composerProjectSelector.projectsHeading")}
          </div>
        ) : null}
        {namedProjects.map((project) => {
          const isActive = hasRealSelection && projectRootEquals(project.projectRoot, activeProject?.projectRoot);
          return (
            <DropdownMenuItem
              key={project.projectRoot}
              data-testid="composer-project-selector-item"
              data-project-root={project.projectRoot}
              className={isActive ? "bg-primary/(--opacity-subtle) text-primary" : undefined}
              onSelect={() => handleSelect(project)}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{project.projectName}</span>
            </DropdownMenuItem>
          );
        })}
        {namedProjects.length > 0 ? <DropdownMenuSeparator /> : null}
        {pendingWarning ? (
          <div
            data-testid="composer-project-selector-root-warning"
            className="space-y-2 rounded-md border border-destructive bg-destructive/(--opacity-muted) p-2 text-[11px]"
          >
            <div className="font-medium text-destructive">{t("composerProjectSelector.rootWarningTitle")}</div>
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground [overflow-wrap:anywhere]">
              {pendingWarning.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                data-testid="composer-project-selector-root-warning-confirm"
                onClick={() => void handleConfirmPending()}
              >
                {t("composerProjectSelector.rootWarningConfirm")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                data-testid="composer-project-selector-root-warning-cancel"
                onClick={cancelPendingFolder}
              >
                {t("composerProjectSelector.cancelButton")}
              </Button>
            </div>
          </div>
        ) : (
          <DropdownMenuItem
            data-testid="composer-project-selector-add"
            disabled={busy}
            onSelect={(event) => {
              // Keep the menu open across the async picker round trip — Radix
              // closes on select by default, which would race the native
              // dialog. We close explicitly once the flow resolves.
              event.preventDefault();
              void handleAddProject();
            }}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t("composerProjectSelector.addProject")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
