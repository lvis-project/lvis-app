export async function loadMainStartupDependencies<TBootModule>(
  loadBootModule: () => Promise<TBootModule>,
  prepareCorporateCa: () => Promise<void>,
): Promise<TBootModule> {
  const [bootModule] = await Promise.all([
    loadBootModule(),
    prepareCorporateCa(),
  ]);
  return bootModule;
}
