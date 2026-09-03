import { useCallback, useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Switch } from "../../../components/ui/switch.js";
import { Textarea } from "../../../components/ui/textarea.js";
import type { RolePreset } from "../../../data/role-presets.js";
import { isIpcErrorResult, type LvisApi } from "../types.js";
import type { HomeDocsStatus } from "../../../ipc/domains/home-docs.js";
import { useNotifySaved } from "../context/SavedToastContext.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { FileEditDiff } from "../components/FileEditDiff.js";
import { useTranslation } from "../../../i18n/react.js";
import { errorMessage } from "../../../shared/error-message.js";
import { formatIpcError } from "../format-ipc-error.js";

const EMPTY_DRAFT: RolePreset = { id: "", name: "", systemPromptAdd: "" };

/**
 * Stable anchor for the agent-context controls, so a link into Settings can
 * name this section rather than a scroll offset that moves with the page.
 */
const AGENTS_SECTION_ID = "settings-agents-md";

export function RolesTab({ api }: { api: LvisApi }) {
  const { t } = useTranslation();
  const notifySaved = useNotifySaved();
  const [rolePresets, setRolePresets] = useState<RolePreset[]>([]);
  const [draft, setDraft] = useState<RolePreset>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [agentsDraft, setAgentsDraft] = useState("");
  const [agentsBase, setAgentsBase] = useState("");
  const [customDraft, setCustomDraft] = useState("");
  const [customBase, setCustomBase] = useState("");
  const [keepLatest, setKeepLatest] = useState(false);
  const [homeDocs, setHomeDocs] = useState<HomeDocsStatus | null>(null);
  const [markerDiff, setMarkerDiff] = useState<
    { markerPath: string; live: string; content: string } | null
  >(null);
  const [merged, setMerged] = useState<string | null>(null);
  const [memoryIndex, setMemoryIndex] = useState("");
  const [memoryIndexBase, setMemoryIndexBase] = useState("");
  const [userPrefsDraft, setUserPrefsDraft] = useState("");
  const [quickMemory, setQuickMemory] = useState("");
  const [quickLinks, setQuickLinks] = useState("");
  const [detailMemoryTitle, setDetailMemoryTitle] = useState("");
  const [detailMemory, setDetailMemory] = useState("");
  const [detailLinks, setDetailLinks] = useState("");
  const [loading, setLoading] = useState(true);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    const failures: string[] = [];

    try {
      const { prompts } = await api.listPersonaPrompts();
      setRolePresets(prompts);
      setRolesLoaded(true);
    } catch (err) {
      failures.push(`roles: ${errorMessage(err)}`);
      setRolesLoaded(false);
    }

    const [agents, memory, prefs, docs, custom, settings] = await Promise.allSettled([
      api.memoryGetAgentsMd(),
      api.memoryGetIndex(),
      api.memoryGetUserPrefs(),
      api.homeDocsStatus(),
      api.homeDocsGetCustom(),
      api.getSettings(),
    ]);
    if (agents.status === "fulfilled") {
      setAgentsDraft(agents.value);
      setAgentsBase(agents.value);
    } else failures.push(`AGENTS.md: ${errorMessage(agents.reason)}`);
    if (docs.status === "fulfilled") {
      setHomeDocs(docs.value);
      setMerged(docs.value.mergedContent);
    } else failures.push(`~/.lvis: ${errorMessage(docs.reason)}`);
    if (custom.status === "fulfilled") {
      setCustomDraft(custom.value);
      setCustomBase(custom.value);
    } else failures.push(`agents.custom.md: ${errorMessage(custom.reason)}`);
    if (settings.status === "fulfilled") setKeepLatest(settings.value.homeDocs.keepLatest);
    else failures.push(`settings: ${errorMessage(settings.reason)}`);
    if (memory.status === "fulfilled") {
      setMemoryIndex(memory.value);
      setMemoryIndexBase(memory.value);
    } else failures.push(`MEMORY.md: ${errorMessage(memory.reason)}`);
    if (prefs.status === "fulfilled") setUserPrefsDraft(prefs.value);
    else
      failures.push(`user-preferences.md: ${errorMessage(prefs.reason)}`);

    if (failures.length > 0) {
      setError(failures.join("\n"));
    }
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void loadSources();
    const unsubscribe = api.onPersonaPromptsUpdated?.(() => {
      void api
        .listPersonaPrompts()
        .then(({ prompts }) => {
          setRolePresets(prompts);
          setRolesLoaded(true);
        })
        .catch(() => {
          setRolesLoaded(false);
        });
    });
    return () => {
      unsubscribe?.();
    };
  }, [api, loadSources]);

  const reloadPersonaPrompts = useCallback(async () => {
    const { prompts } = await api.listPersonaPrompts();
    setRolePresets(prompts);
    setRolesLoaded(true);
  }, [api]);

  const startEdit = (preset: RolePreset) => {
    if (preset.isDefault) return;
    setEditingId(preset.id);
    setDraft({ ...preset });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  };

  const saveDraft = async () => {
    const name = draft.name.trim();
    if (!name) return;
    setSaving("roles");
    setError(null);
    try {
      const id = editingId ?? makePersonaPromptId(name);
      const result = await api.savePersonaPrompt({
        id,
        name,
        systemPromptAdd: draft.systemPromptAdd,
      });
      if (!result.ok) throw new Error(result.error);
      await reloadPersonaPrompts();
      setStatus(t("rolesTab.statusRoleSaved"));
      notifySaved();
      cancelEdit();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const removePreset = async (id: string) => {
    const target = rolePresets.find((preset) => preset.id === id);
    if (!target || target.isDefault) return;
    setSaving("roles");
    setError(null);
    try {
      const result = await api.deletePersonaPrompt(id);
      if (!result.ok) throw new Error(result.error);
      await reloadPersonaPrompts();
      setStatus(t("rolesTab.statusRoleDeleted"));
      notifySaved();
      if (editingId === id) cancelEdit();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const saveAgents = async () => {
    setSaving("agents");
    setError(null);
    try {
      // Keep-latest moves authorship: the live doc is the packaged reference
      // from then on, and the editor writes what the user owns.
      if (keepLatest) {
        const result = await api.homeDocsUpdateCustom(customDraft);
        if (!result.ok) throw new Error(formatIpcError(result.error, undefined));
        setCustomBase(customDraft);
      } else {
        await api.memoryUpdateAgentsMd(agentsDraft);
        setAgentsBase(agentsDraft);
      }
      setStatus(t("rolesTab.statusAgentsSaved"));
      notifySaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const reloadHomeDocs = useCallback(async () => {
    const [docs, agents, custom] = await Promise.all([
      api.homeDocsStatus(),
      api.memoryGetAgentsMd(),
      api.homeDocsGetCustom(),
    ]);
    setHomeDocs(docs);
    setMerged(docs.mergedContent);
    setAgentsDraft(agents);
    setAgentsBase(agents);
    setCustomDraft(custom);
    setCustomBase(custom);
  }, [api]);

  const toggleKeepLatest = async (next: boolean) => {
    setSaving("home-docs-keep-latest");
    setError(null);
    try {
      const result = await api.updateSettings({ homeDocs: { keepLatest: next } });
      if (isIpcErrorResult(result)) throw new Error(formatIpcError(result.error, undefined));
      setKeepLatest(next);
      notifySaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const showMarkerDiff = async (markerPath: string) => {
    setSaving("home-docs-diff");
    setError(null);
    try {
      const result = await api.homeDocsReadMarker(markerPath);
      if (!result.ok) throw new Error(formatIpcError(result.error, undefined));
      setMarkerDiff({ markerPath, live: result.live, content: result.content });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const applyPackaged = async (markerPath: string) => {
    setSaving("home-docs-apply");
    setError(null);
    try {
      const result = await api.homeDocsApplyPackaged(markerPath);
      if (!result.ok) throw new Error(formatIpcError(result.error, undefined));
      setMarkerDiff(null);
      await reloadHomeDocs();
      setStatus(
        result.movedToCustom
          ? t("rolesTab.statusPackagedAppliedWithCustom")
          : t("rolesTab.statusPackagedApplied"),
      );
      notifySaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const keepMine = async (markerPath: string) => {
    setSaving("home-docs-keep-mine");
    setError(null);
    try {
      const result = await api.homeDocsKeepMine(markerPath);
      if (!result.ok) throw new Error(formatIpcError(result.error, undefined));
      setMarkerDiff(null);
      await reloadHomeDocs();
      setStatus(t("rolesTab.statusKeptMine"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const runMerge = async (markerPath?: string) => {
    setSaving("home-docs-merge");
    setError(null);
    try {
      const result = await api.homeDocsMerge(markerPath);
      if (!result.ok) throw new Error(formatIpcError(result.error, undefined));
      setMerged(result.content);
      setStatus(t("rolesTab.statusMerged"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const applyMerged = async () => {
    setSaving("home-docs-apply-merged");
    setError(null);
    try {
      // The baseline is what this surface last loaded, so an edit that landed
      // while the model was working is a conflict rather than a silent loss.
      const result = await api.homeDocsApplyMerged(keepLatest ? customBase : agentsBase);
      if (!result.ok) throw new Error(formatIpcError(result.error, undefined));
      setMerged(null);
      await reloadHomeDocs();
      setStatus(t("rolesTab.statusMergedApplied"));
      notifySaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const discardMerged = async () => {
    setSaving("home-docs-discard-merged");
    setError(null);
    try {
      await api.homeDocsDiscardMerged();
      setMerged(null);
      setStatus(t("rolesTab.statusMergedDiscarded"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const saveUserPrefs = async () => {
    setSaving("preferences");
    setError(null);
    try {
      await api.memoryUpdateUserPrefs(userPrefsDraft);
      setStatus(t("rolesTab.statusUserPrefsSaved"));
      notifySaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const refreshUserPrefs = async () => {
    setSaving("refresh-preferences");
    setError(null);
    try {
      const result = await api.memoryRefreshUserPrefs();
      if (!result.ok) throw new Error(result.error);
      setUserPrefsDraft(result.content);
      setStatus(t("rolesTab.statusUserPrefsRefreshed"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const refreshLongTermMemory = async () => {
    setSaving("refresh-long-term-memory");
    setError(null);
    try {
      const result = await api.memoryRefreshLongTerm();
      if (!result.ok) {
        throw new Error(
          result.error === "memory-consolidation-service-unavailable"
            ? t("rolesTab.errorLongTermMemoryConsolidationUnavailable")
            : t("rolesTab.errorLongTermMemoryConsolidationFailed"),
        );
      }
      if (result.global.status === "updated" || result.project?.status === "updated") {
        setStatus(t("rolesTab.statusLongTermMemoryConsolidated"));
        notifySaved();
      } else if (
        result.global.status === "empty" &&
        (!result.project || result.project.status === "empty")
      ) {
        setStatus(t("rolesTab.statusLongTermMemoryEmpty"));
      } else {
        setStatus(t("rolesTab.statusLongTermMemoryUpToDate"));
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const refreshMemoryIndex = async () => {
    setSaving("memory-index");
    setError(null);
    try {
      const latest = await api.memoryGetIndex();
      setMemoryIndex(latest);
      setMemoryIndexBase(latest);
      setStatus(t("rolesTab.statusMemoryReloaded"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const saveMemoryIndex = async () => {
    setSaving("memory-index-save");
    setError(null);
    try {
      const didUpdate = await api.memoryUpdateIndexIfUnchanged(
        memoryIndexBase,
        memoryIndex,
      );
      const latest = await api.memoryGetIndex();
      setMemoryIndex(latest);
      setMemoryIndexBase(latest);
      if (!didUpdate) {
        throw new Error(t("rolesTab.errorMemoryConflict"));
      }
      setStatus(t("rolesTab.statusMemorySaved"));
      notifySaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const saveQuickMemory = async () => {
    const content = quickMemory.trim();
    if (!content) return;
    setSaving("quick-memory");
    setError(null);
    try {
      const links = quickLinks.trim();
      const result = (await api.memoryUpdateIndexSections({
        urgentMemory: content,
        references: links,
      })) as { ok?: boolean; error?: string } | undefined;
      if (result && result.ok === false)
        throw new Error(
          result.error ?? t("rolesTab.errorMemorySectionSaveFailed"),
        );
      setQuickMemory("");
      setQuickLinks("");
      const latest = await api.memoryGetIndex();
      setMemoryIndex(latest);
      setMemoryIndexBase(latest);
      setStatus(t("rolesTab.statusQuickMemorySaved"));
      notifySaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const saveDetailedMemory = async () => {
    const title = detailMemoryTitle.trim();
    const content = detailMemory.trim();
    if (!title || !content) return;
    setSaving("detail-memory");
    setError(null);
    try {
      const links = detailLinks.trim();
      await api.memorySaveEntry(
        title,
        links ? `${content}\n\n## References\n${links}` : content,
      );
      setDetailMemoryTitle("");
      setDetailMemory("");
      setDetailLinks("");
      const latest = await api.memoryGetIndex();
      setMemoryIndex(latest);
      setMemoryIndexBase(latest);
      setStatus(t("rolesTab.statusDetailMemorySaved"));
      notifySaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const memoryBusy =
    saving === "memory-index" ||
    saving === "memory-index-save" ||
    saving === "quick-memory" ||
    saving === "detail-memory" ||
    saving === "refresh-long-term-memory";

  const preferencesBusy =
    saving === "preferences" || saving === "refresh-preferences";

  const homeDocsBusy = saving?.startsWith("home-docs") === true;
  const markers = homeDocs?.markers ?? [];
  const agentsMarker = markers.find((marker) => marker.actionable);

  return (
    <div className="min-w-0 space-y-6">
      <SettingsPageHeader
        title={t("rolesTab.pageTitle")}
        description={t("rolesTab.pageDescription")}
      />

      {/* Inline sections (converted from the former button-based sub-nav):
          Agents / Memory / Preferences / Roles / Preview are stacked and all
          visible, so the whole memory + persona surface scrolls as one page. */}
      <SettingsSection
        id={AGENTS_SECTION_ID}
        title={t("rolesTab.sectionAgents")}
        badge={
          loading ? (
            <Badge variant="secondary">{t("rolesTab.loadingBadge")}</Badge>
          ) : undefined
        }
      >
        <div className="space-y-3" data-testid="roles-tab:agents-section">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {keepLatest
                ? homeDocs?.customDisplayPath ?? ""
                : homeDocs?.agentsDisplayPath ?? ""}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("rolesTab.keepLatestLabel")}
              </span>
              <Switch
                checked={keepLatest}
                onCheckedChange={(next: boolean) => void toggleKeepLatest(next)}
                disabled={homeDocsBusy}
                aria-label={t("rolesTab.keepLatestLabel")}
                data-testid="roles-tab:keep-latest"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("rolesTab.keepLatestHint")}</p>

          <Textarea
            value={keepLatest ? customDraft : agentsDraft}
            onChange={(event) =>
              keepLatest
                ? setCustomDraft(event.target.value)
                : setAgentsDraft(event.target.value)
            }
            className="min-h-[320px] font-mono text-xs"
            data-testid="roles-tab:agents-editor"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={saveAgents}
              disabled={saving === "agents"}
            >
              {saving === "agents"
                ? t("rolesTab.savingLabel")
                : t("rolesTab.saveAgentsButton")}
            </Button>
          </div>

          {keepLatest ? (
            <div className="space-y-2" data-testid="roles-tab:packaged-view">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="secondary">{t("rolesTab.packagedBadge")}</Badge>
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {homeDocs?.agentsDisplayPath ?? ""}
                </span>
              </div>
              <Textarea
                value={agentsDraft}
                readOnly
                className="min-h-[160px] font-mono text-xs"
              />
            </div>
          ) : null}

          {markers.length > 0 ? (
            <div className="space-y-2" data-testid="roles-tab:upgrade-markers">
              <div className="text-xs font-medium text-foreground">
                {t("rolesTab.upgradeMarkersTitle", { count: String(markers.length) })}
              </div>
              {markers.map((marker) => (
                <div
                  key={marker.markerPath}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <span className="min-w-0 truncate font-mono text-xs">
                    {marker.markerDisplayPath}
                  </span>
                  {marker.actionable ? (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={homeDocsBusy}
                        onClick={() => void showMarkerDiff(marker.markerPath)}
                        data-testid={`roles-tab:marker-diff:${marker.markerPath}`}
                      >
                        {t("rolesTab.viewDiffButton")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={homeDocsBusy}
                        onClick={() => void applyPackaged(marker.markerPath)}
                        data-testid={`roles-tab:marker-apply:${marker.markerPath}`}
                      >
                        {t("rolesTab.applyPackagedButton")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={homeDocsBusy}
                        onClick={() => void keepMine(marker.markerPath)}
                        data-testid={`roles-tab:marker-keep:${marker.markerPath}`}
                      >
                        {t("rolesTab.keepMineButton")}
                      </Button>
                    </div>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("rolesTab.markerReadOnlyNote")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {markerDiff ? (
            <FileEditDiff
              data={{
                path: homeDocs?.agentsDisplayPath ?? markerDiff.markerPath,
                tool: "write_file",
                hunks: [{ oldText: markerDiff.live, newText: markerDiff.content }],
              }}
            />
          ) : null}

          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={homeDocsBusy}
              onClick={() => void runMerge(agentsMarker?.markerPath)}
              data-testid="roles-tab:merge-agents"
            >
              {saving === "home-docs-merge"
                ? t("rolesTab.mergingLabel")
                : t("rolesTab.mergeButton")}
            </Button>
          </div>

          {merged !== null ? (
            <div className="space-y-2" data-testid="roles-tab:merged-result">
              <div className="text-xs font-medium text-foreground">
                {t("rolesTab.mergedTitle")}
              </div>
              <Textarea
                value={merged}
                readOnly
                className="min-h-[240px] font-mono text-xs"
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={homeDocsBusy}
                  onClick={() => void discardMerged()}
                  data-testid="roles-tab:merged-discard"
                >
                  {t("rolesTab.discardMergedButton")}
                </Button>
                <Button
                  size="sm"
                  disabled={homeDocsBusy}
                  onClick={() => void applyMerged()}
                  data-testid="roles-tab:merged-apply"
                >
                  {t("rolesTab.applyMergedButton")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title={t("rolesTab.sectionMemory")}>
        <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_320px]">
          <Textarea
            value={memoryIndex}
            onChange={(event) => setMemoryIndex(event.target.value)}
            className="min-w-0 min-h-[420px] font-mono text-xs"
          />
          <div className="min-w-0 space-y-4">
            <div className="min-w-0 space-y-2">
              <Textarea
                value={quickMemory}
                maxLength={520}
                onChange={(event) => setQuickMemory(event.target.value)}
                placeholder={t("rolesTab.quickMemoryPlaceholder")}
                className="min-w-0 min-h-[120px] text-xs"
              />
              <div className="text-right text-[11px] text-muted-foreground">
                {quickMemory.length}/520
              </div>
              <Textarea
                value={quickLinks}
                onChange={(event) => setQuickLinks(event.target.value)}
                placeholder={t("rolesTab.referenceLinkPlaceholder")}
                className="min-w-0 min-h-[70px] text-xs"
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={refreshMemoryIndex}
                  disabled={memoryBusy}
                >
                  {t("rolesTab.reloadButton")}
                </Button>
                <Button
                  data-testid="roles-tab:refresh-long-term-memory"
                  size="sm"
                  variant="outline"
                  onClick={refreshLongTermMemory}
                  disabled={memoryBusy}
                >
                  {saving === "refresh-long-term-memory"
                    ? t("rolesTab.consolidatingLongTermMemoryLabel")
                    : t("rolesTab.consolidateLongTermMemoryButton")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={saveMemoryIndex}
                  disabled={memoryBusy}
                >
                  {t("rolesTab.saveMemoryButton")}
                </Button>
                <Button
                  size="sm"
                  onClick={saveQuickMemory}
                  disabled={!quickMemory.trim() || memoryBusy}
                >
                  {t("rolesTab.saveToSectionButton")}
                </Button>
              </div>
            </div>
            <div className="space-y-2 border-t border-border/(--opacity-stronger) pt-3">
              <Input
                value={detailMemoryTitle}
                onChange={(event) => setDetailMemoryTitle(event.target.value)}
                placeholder={t("rolesTab.detailMemoryTitlePlaceholder")}
              />
              <Textarea
                value={detailMemory}
                onChange={(event) => setDetailMemory(event.target.value)}
                placeholder={t("rolesTab.detailMemoryPlaceholder")}
                className="min-h-[110px] text-xs"
              />
              <Textarea
                value={detailLinks}
                onChange={(event) => setDetailLinks(event.target.value)}
                placeholder={t("rolesTab.referenceLinkPlaceholder")}
                className="min-w-0 min-h-[70px] text-xs"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={saveDetailedMemory}
                  disabled={
                    !detailMemoryTitle.trim() ||
                    !detailMemory.trim() ||
                    memoryBusy
                  }
                >
                  {t("rolesTab.saveDetailMemoryButton")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t("rolesTab.sectionPreferences")}>
        <div className="space-y-3">
          <Textarea
            value={userPrefsDraft}
            onChange={(event) => setUserPrefsDraft(event.target.value)}
            className="min-h-[320px] font-mono text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={refreshUserPrefs}
              disabled={preferencesBusy}
            >
              {saving === "refresh-preferences"
                ? t("rolesTab.refreshingLabel")
                : t("rolesTab.refreshWithLlmButton")}
            </Button>
            <Button
              size="sm"
              onClick={saveUserPrefs}
              disabled={preferencesBusy}
            >
              {saving === "preferences"
                ? t("rolesTab.savingLabel")
                : t("rolesTab.saveUserPrefsButton")}
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t("rolesTab.sectionRoles")}>
        <div className="space-y-3">
          <div className="space-y-2">
            {rolePresets.map((preset) => (
              <div
                key={preset.id}
                className="rounded-md border border-border/(--opacity-stronger) p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {preset.name}
                      {preset.isDefault ? (
                        <Badge variant="secondary" className="ml-2 text-[10px]">
                          {t("rolesTab.defaultBadge")}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {preset.systemPromptAdd || t("rolesTab.noRolePrompt")}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px]"
                      onClick={() => startEdit(preset)}
                      disabled={!rolesLoaded || Boolean(preset.isDefault)}
                    >
                      {t("rolesTab.editButton")}
                    </Button>
                    {!preset.isDefault ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px] text-destructive"
                        onClick={() => void removePreset(preset.id)}
                        disabled={!rolesLoaded}
                      >
                        {t("rolesTab.deleteButton")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-md border border-border/(--opacity-stronger) p-3">
            <div className="mb-2 text-sm font-medium">
              {editingId
                ? t("rolesTab.editPromptHeading")
                : t("rolesTab.newRolePromptHeading")}
            </div>
            <div className="space-y-2">
              <Input
                placeholder={t("rolesTab.namePlaceholder")}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
              <Textarea
                placeholder={t("rolesTab.systemPromptPlaceholder")}
                value={draft.systemPromptAdd}
                onChange={(event) =>
                  setDraft({ ...draft, systemPromptAdd: event.target.value })
                }
                className="min-h-[90px]"
              />
              <div className="flex justify-end gap-2">
                {editingId ? (
                  <Button size="sm" variant="ghost" onClick={cancelEdit}>
                    {t("rolesTab.cancelButton")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={() => void saveDraft()}
                  disabled={
                    !rolesLoaded || !draft.name.trim() || saving === "roles"
                  }
                >
                  {editingId
                    ? t("rolesTab.updateButton")
                    : t("rolesTab.addButton")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t("rolesTab.sectionPreview")}>
        <pre className="overflow-auto rounded-md bg-muted/(--opacity-half) p-3 text-xs leading-5">
          {`AGENTS.md                  -> project / org / agent operating context
agents.custom.md            -> your own agent context under keep-latest, read after AGENTS.md
AGENTS.md.merged            -> merge awaiting review; never read by the runtime
memories/MEMORY.md          -> urgent memory, references, and saved-memory index
memories/*.md               -> detailed long-term memories with references
user-preferences.md         -> compact durable user preferences only
prompts/*.md                -> user-editable per-turn persona prompts

Idle:
  IDLE_SCAN -> optionally refresh user-preferences.md from sources, preferences only

Turn:
  system prompt reads AGENTS.md + user-preferences.md + MEMORY.md + memories/*.md
  selected persona prompt is injected as a per-turn system prompt section`}
        </pre>
      </SettingsSection>

      {status ? (
        <div className="text-xs text-muted-foreground">{status}</div>
      ) : null}
      {error ? (
        <div className="whitespace-pre-line text-xs text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function makePersonaPromptId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "persona";
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}
