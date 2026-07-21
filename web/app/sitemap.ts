import type { MetadataRoute } from "next";
import { flattenNavFor } from "@/lib/navigation";

export const dynamic = "force-static";

/**
 * Sitemap derived from lib/navigation(.en).ts so it can never drift from the
 * nav — both locales. With trailingSlash: true every route resolves slashed.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://lvisai.xyz";
  const slash = (href: string) => (href.endsWith("/") ? href : `${href}/`);
  const docRoutes = (["ko", "en"] as const).flatMap((locale) =>
    flattenNavFor(locale).map((item) => ({
      url: `${base}${slash(item.href)}`,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }))
  );
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/en/`, changeFrequency: "weekly", priority: 0.9 },
    ...docRoutes,
  ];
}
