/**
 * Bundled publisher public keys for plugin manifest signature verification.
 *
 * Sprint 4-B §B-4 — wired end-to-end via boot.ts. Managed plugins whose `.sig`
 * cannot be verified against any key here are fail-closed (not loaded) unless
 * the dev escape hatch `LVIS_DEV_SKIP_SIG=1` is set. User plugins with missing
 * signatures still load with a warning.
 *
 * TODO(production): replace the development key below with the production
 * LGE publisher key once the signing pipeline is in place. The current key is
 * intended for development and CI fixtures only — it is documented as
 * "development-only" so it is obvious on audit.
 */

/** Development-only ed25519 SPKI public key (PEM). NOT FOR PRODUCTION USE. */
export const DEVELOPMENT_PUBLISHER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=
-----END PUBLIC KEY-----
`;

/**
 * Host-bundled publisher public keys. Extend this array with rotated keys; the
 * verifier accepts a signature that matches ANY configured key. Keep entries
 * annotated with the key purpose (development / production / rotated-YYYY-MM).
 */
export const BUNDLED_PUBLISHER_PUBLIC_KEYS: string[] = [
  DEVELOPMENT_PUBLISHER_PUBLIC_KEY_PEM,
];
