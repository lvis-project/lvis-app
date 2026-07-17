export function linuxExecutablePreferenceSuffixes(arch, separator) {
  const names = ["LVIS", "lvis", "lvis-app"];
  return [
    ...names.map((name) => `linux-${arch}-unpacked${separator}${name}`),
    ...names.map((name) => `linux-unpacked${separator}${name}`),
  ];
}

export function pickBestByExactSuffix(paths, preferredSuffixes) {
  const rank = (path) => {
    const index = preferredSuffixes.findIndex((suffix) => path.endsWith(suffix));
    return index === -1 ? preferredSuffixes.length : index;
  };
  return [...paths].sort((a, b) =>
    rank(a) - rank(b) || a.length - b.length || a.localeCompare(b)
  )[0] ?? null;
}
