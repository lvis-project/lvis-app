export async function loadMainStartupDependencies<TBootModule>(
  loadBootModule: () => Promise<TBootModule>,
  prepareCorporateCa: () => Promise<void>,
  onCorporateCaReady: () => void,
): Promise<TBootModule> {
  const bootOutcomePromise = loadBootModule().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await prepareCorporateCa();
  onCorporateCaReady();
  const bootOutcome = await bootOutcomePromise;
  if (!bootOutcome.ok) throw bootOutcome.error;
  return bootOutcome.value;
}
