export const SAFE_ARTIFACT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Canonical plugin/artifact identifier accepted at every filesystem boundary. */
export function assertSafeArtifactSlug(slug: string): string {
  if (!SAFE_ARTIFACT_SLUG_RE.test(slug)) {
    throw new Error(
      `invalid artifact slug "${slug}" — expected ${SAFE_ARTIFACT_SLUG_RE.source}`,
    );
  }
  return slug;
}
