import type { UsageSummaryShape } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";

interface InsightsUsageBreakdownProps {
  summary: Partial<UsageSummaryShape> | null;
  monthLabel: string;
  loading?: boolean;
  error?: boolean;
}

function formatTokens(value: number | undefined): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    Math.max(0, value ?? 0),
  );
}

function byTokensDesc<T extends { totalTokens?: number }>(rows: readonly T[] | undefined): T[] {
  return [...(rows ?? [])].sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0));
}

export function InsightsUsageBreakdown({
  summary,
  monthLabel,
  loading = false,
  error = false,
}: InsightsUsageBreakdownProps) {
  const { t } = useTranslation();
  const apiProviders = byTokensDesc(summary?.perVendor);
  const apiModels = byTokensDesc(summary?.perModel);
  const subscriptionProviders = byTokensDesc(summary?.subscription?.perRuntime);
  const subscriptionModels = byTokensDesc(summary?.subscription?.perModel);

  const stateMessage = loading
    ? t("usageDashboard.loading")
    : error
      ? t("usageDashboard.loadError")
      : t("usageDashboard.noData");

  return (
    <div
      data-testid="insights-monthly-usage-breakdown"
      className="mt-4 grid shrink-0 gap-4 lg:grid-cols-2"
    >
      <section
        data-testid="insights-provider-usage"
        className="min-w-0 overflow-hidden rounded-md border bg-background"
      >
        <header className="border-b px-3 py-2">
          <h3 className="text-sm font-semibold text-foreground">{t("usageDashboard.perVendor")}</h3>
          <p className="text-xs text-muted-foreground">{monthLabel}</p>
        </header>
        <div className="max-h-64 space-y-3 overflow-y-auto p-3">
          {apiProviders.length > 0 ? (
            <table data-testid="insights-api-provider-usage" className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-1 font-medium">{t("usageDashboard.colVendor")}</th>
                  <th className="pb-1 text-right font-medium">{t("usageDashboard.colTokens")}</th>
                </tr>
              </thead>
              <tbody>
                {apiProviders.map((row) => (
                  <tr key={row.vendor} className="border-t">
                    <td className="break-all py-1.5 font-mono">{row.vendor}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatTokens(row.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {subscriptionProviders.length > 0 ? (
            <div className={apiProviders.length > 0 ? "border-t pt-3" : undefined}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t("usageDashboard.subscriptionUsageTitle")}
              </p>
              <table data-testid="insights-subscription-provider-usage" className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-1 font-medium">{t("usageDashboard.subscriptionRuntime")}</th>
                    <th className="pb-1 text-right font-medium">{t("usageDashboard.colTokens")}</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptionProviders.map((row) => (
                    <tr key={row.provider} className="border-t">
                      <td className="break-all py-1.5 font-mono">{row.provider}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatTokens(row.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {apiProviders.length === 0 && subscriptionProviders.length === 0 ? (
            <p className="text-xs text-muted-foreground">{stateMessage}</p>
          ) : null}
        </div>
      </section>

      <section
        data-testid="insights-model-usage"
        className="min-w-0 overflow-hidden rounded-md border bg-background"
      >
        <header className="border-b px-3 py-2">
          <h3 className="text-sm font-semibold text-foreground">{t("usageDashboard.perModel")}</h3>
          <p className="text-xs text-muted-foreground">{monthLabel}</p>
        </header>
        <div className="max-h-64 space-y-3 overflow-y-auto p-3">
          {apiModels.length > 0 ? (
            <table data-testid="insights-api-model-usage" className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-1 font-medium">{t("usageDashboard.colModel")}</th>
                  <th className="pb-1 text-right font-medium">{t("usageDashboard.colTokens")}</th>
                </tr>
              </thead>
              <tbody>
                {apiModels.map((row) => (
                  <tr key={`${row.vendor}:${row.model}`} className="border-t">
                    <td className="break-all py-1.5 font-mono">
                      <span className="text-muted-foreground">{row.vendor}/</span>{row.model}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatTokens(row.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {subscriptionModels.length > 0 ? (
            <div className={apiModels.length > 0 ? "border-t pt-3" : undefined}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t("usageDashboard.subscriptionUsageTitle")}
              </p>
              <table data-testid="insights-subscription-model-usage" className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-1 font-medium">{t("usageDashboard.colModel")}</th>
                    <th className="pb-1 text-right font-medium">{t("usageDashboard.colTokens")}</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptionModels.map((row) => (
                    <tr key={`${row.provider}:${row.model}`} className="border-t">
                      <td className="break-all py-1.5 font-mono">
                        <span className="text-muted-foreground">{row.provider}/</span>{row.model}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{formatTokens(row.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {apiModels.length === 0 && subscriptionModels.length === 0 ? (
            <p className="text-xs text-muted-foreground">{stateMessage}</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
