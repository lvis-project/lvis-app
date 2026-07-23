import { useCallback, useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Textarea } from "../../../components/ui/textarea.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { LvisApi } from "../types.js";
import { useNotifySaved } from "../contexts/saved-toast.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useTranslation } from "../../../i18n/react.js";

const EMPTY_DRAFT: RolePreset = { id: "", name: "", systemPromptAdd: "" };

export function RolesTab({ api }: { api: LvisApi }) {
  const { t } = useTranslation();
  const notifySaved = useNotifySaved();
  const [rolePresets, setRolePresets] = useState<RolePreset[]>([]);
  const [draft, setDraft] = useState<RolePreset>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [agentsDraft, setAgentsDraft] = useState("");
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
      failures.push(`roles: ${(err as Error).message}`);
      setRolesLoaded(false);
    }

    const [agents, memory, prefs] = await Promise.allSettled([
      api.memoryGetAgentsMd(),
      api.memoryGetIndex(),
      api.memoryGetUserPrefs(),
    ]);
    if (agents.status === "fulfilled") setAgentsDraft(agents.value);
    else failures.push(`AGENTS.md: ${(agents.reason as Error).message}`);
    if (memory.status === "fulfilled") {
      setMemoryIndex(memory.value);
      setMemoryIndexBase(memory.value);
    } else failures.push(`MEMORY.md: ${(memory.reason as Error).message}`);
    if (prefs.status === "fulfilled") setUserPrefsDraft(prefs.value);
    else
      failures.push(`user-preferences.md: ${(prefs.reason as Error).message}`);

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
      setError((err as Error).message);
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
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const saveAgents = async () => {
    setSaving("agents");
    setError(null);
    try {
      await api.memoryUpdateAgentsMd(agentsDraft);
      setStatus(t("rolesTab.statusAgentsSaved"));
      notifySaved();
    } catch (err) {
      setError((err as Error).message);
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
      setError((err as Error).message);
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
      setError((err as Error).message);
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
      setError((err as Error).message);
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
      setError((err as Error).message);
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
      setError((err as Error).message);
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
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const preferencesBusy =
    saving === "preferences" || saving === "refresh-preferences";

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
        title={t("rolesTab.sectionAgents")}
        badge={
          loading ? (
            <Badge variant="secondary">{t("rolesTab.loadingBadge")}</Badge>
          ) : undefined
        }
      >
        <div className="space-y-3">
          <Textarea
            value={agentsDraft}
            onChange={(event) => setAgentsDraft(event.target.value)}
            className="min-h-[320px] font-mono text-xs"
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
                  disabled={saving === "memory-index"}
                >
                  {t("rolesTab.reloadButton")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={saveMemoryIndex}
                  disabled={saving === "memory-index-save"}
                >
                  {t("rolesTab.saveMemoryButton")}
                </Button>
                <Button
                  size="sm"
                  onClick={saveQuickMemory}
                  disabled={!quickMemory.trim() || saving === "quick-memory"}
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
                    saving === "detail-memory"
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
