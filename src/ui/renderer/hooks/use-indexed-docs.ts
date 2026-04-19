import { useCallback, useState } from "react";
import type { LvisApi } from "../types.js";

/**
 * PageIndex document list loader. Extracted from App.tsx — finds the
 * `knowledge-index` capable plugin and calls its list tool, normalising the
 * shape into `{ id, name }[]`.
 */
export function useIndexedDocs(api: LvisApi) {
  const [indexedDocs, setIndexedDocs] = useState<Array<{ id: string; name: string }>>([]);
  const [docsLoading, setDocsLoading] = useState(false);

  const refreshIndexedDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const cards = await api.listPluginCards();
      const indexPlugin = cards.find((c) => c.capabilities.includes("knowledge-index"));
      const listTool = indexPlugin?.tools.find((t) => /list.*document/i.test(t));
      let result: unknown = null;
      if (listTool) {
        try { result = await api.callPluginMethod(listTool, {}); } catch { /* no-op */ }
      }
      const list = Array.isArray(result) ? result : (result as any)?.documents ?? (result as any)?.items ?? [];
      const normalized: Array<{ id: string; name: string }> = (list as any[])
        .map((d) => ({ id: String(d.id ?? d.docId ?? d.path ?? ""), name: String(d.name ?? d.title ?? d.filename ?? d.path ?? d.id ?? "") }))
        .filter((d) => d.id && d.name);
      setIndexedDocs(normalized);
    } catch {
      setIndexedDocs([]);
    } finally {
      setDocsLoading(false);
    }
  }, [api]);

  return { indexedDocs, docsLoading, refreshIndexedDocs };
}
