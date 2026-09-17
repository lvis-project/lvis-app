export type OperatorAttestationVerifier = (path: string) => Promise<unknown>;

async function verifyWithSystemAuthority(path: string): Promise<unknown> {
  const { verifyAndPublishOperatorContainerAttestation } = await import(
    "../permissions/operator-container-attestation.js"
  );
  return verifyAndPublishOperatorContainerAttestation(path);
}

/** Run the first authority-bearing boot step only after explicit evidence verifies. */
export async function startAfterOperatorAttestation<T>(
  attestationPath: string | undefined,
  start: () => Promise<T>,
  verify: OperatorAttestationVerifier = verifyWithSystemAuthority,
): Promise<T> {
  if (attestationPath !== undefined) await verify(attestationPath);
  return start();
}
