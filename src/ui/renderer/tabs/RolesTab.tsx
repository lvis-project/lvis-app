import { useCallback, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Textarea } from "../../../components/ui/textarea.js";
import {
  loadRolePresets,
  resetRolePresets,
  saveRolePresets,
  type RolePreset,
} from "../../../data/role-presets.js";

export function RolesTab() {
  const [list, setList] = useState<RolePreset[]>(() => loadRolePresets());
  const [draft, setDraft] = useState<RolePreset>({ id: "", name: "", systemPromptAdd: "", effort: "medium" });
  const [editingId, setEditingId] = useState<string | null>(null);

  const persist = useCallback((next: RolePreset[]) => { setList(next); saveRolePresets(next); }, []);

  const startEdit = (p: RolePreset) => { setEditingId(p.id); setDraft({ ...p }); };
  const cancelEdit = () => { setEditingId(null); setDraft({ id: "", name: "", systemPromptAdd: "", effort: "medium" }); };
  const saveDraft = () => {
    if (!draft.name.trim()) return;
    const id = editingId ?? draft.name.toLowerCase().replace(/\s+/g, "-") + "-" + Math.random().toString(36).slice(2, 6);
    const next = editingId
      ? list.map((p) => p.id === editingId ? { ...draft, id } : p)
      : [...list, { ...draft, id }];
    persist(next);
    cancelEdit();
  };
  const removePreset = (id: string) => {
    const target = list.find((p) => p.id === id);
    if (target?.isDefault) return;
    persist(list.filter((p) => p.id !== id));
  };
  const doReset = () => { setList(resetRolePresets()); cancelEdit(); };

  return (
    <div className="space-y-3 pt-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">프리셋은 전송할 때 시스템 프롬프트 앞에 주입됩니다.</p>
        <Button size="sm" variant="ghost" onClick={doReset}>기본값으로 리셋</Button>
      </div>
      <div className="space-y-2">
        {list.map((p) => (
          <div key={p.id} className="rounded-md border p-2">
            <div className="flex items-center justify-between">
              <div className="font-medium text-sm">{p.name} {p.isDefault ? <Badge variant="secondary" className="ml-1 text-[10px]">기본</Badge> : null}</div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => startEdit(p)}>편집</Button>
                {!p.isDefault && <Button size="sm" variant="ghost" className="h-7 text-[11px] text-destructive" onClick={() => removePreset(p.id)}>삭제</Button>}
              </div>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">effort: {p.effort}</div>
            {p.systemPromptAdd && <div className="mt-1 line-clamp-2 text-xs">{p.systemPromptAdd}</div>}
          </div>
        ))}
      </div>
      <div className="rounded-md border p-3 space-y-2">
        <div className="text-sm font-medium">{editingId ? "프리셋 편집" : "새 프리셋"}</div>
        <Input placeholder="이름" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <Textarea placeholder="systemPromptAdd — 시스템 프롬프트에 주입될 지시사항" value={draft.systemPromptAdd} onChange={(e) => setDraft({ ...draft, systemPromptAdd: e.target.value })} className="min-h-[80px]" />
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1">effort:
            <select className="rounded border bg-background px-1 py-0.5" value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value as any })}>
              <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </select>
          </label>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={saveDraft} disabled={!draft.name.trim()}>{editingId ? "업데이트" : "추가"}</Button>
          {editingId && <Button size="sm" variant="ghost" onClick={cancelEdit}>취소</Button>}
        </div>
      </div>
    </div>
  );
}
