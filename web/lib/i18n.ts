export type Locale = "ko" | "en";

export const locales: Locale[] = ["ko", "en"];
export const defaultLocale: Locale = "ko";

/** Korean lives at the root (legacy URLs preserved); English under /en. */
export function localeFromPathname(pathname: string): Locale {
  return pathname === "/en" || pathname.startsWith("/en/") ? "en" : "ko";
}

/** Strip the /en prefix → the canonical (Korean) path. */
export function stripLocale(pathname: string): string {
  if (pathname === "/en") return "/";
  return pathname.startsWith("/en/") ? pathname.slice(3) : pathname;
}

/** Path for the same page in the target locale. */
export function localePath(pathname: string, target: Locale): string {
  const base = stripLocale(pathname);
  if (target === "ko") return base;
  return base === "/" ? "/en" : `/en${base}`;
}

/** Prefix an internal href for a locale (href given in canonical/Korean form). */
export function href(locale: Locale, canonical: string): string {
  if (locale === "ko") return canonical;
  return canonical === "/" ? "/en" : `/en${canonical}`;
}
