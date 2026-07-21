// Cloudflare Pages Function — GET /download/:platform
//
// Resolves the CURRENT versioned installer from the latest GitHub Release and
// 302-redirects to it. Replaces the removed `LVIS-latest-*` static asset
// aliases: the download buttons stay a stable URL while always pointing at the
// newest versioned asset. Fails open to the Releases page on any error.

const ASSET_PATTERNS = {
  windows: /-windows-x64-setup\.exe$/,
  mac: /-mac-arm64\.dmg$/,
  linux: /-linux-x86_64\.AppImage$/,
};

const LATEST_RELEASE_API =
  "https://api.github.com/repos/lvis-project/lvis-app/releases/latest";
const RELEASES_PAGE = "https://github.com/lvis-project/lvis-app/releases";

export async function onRequestGet(context) {
  const platform = String(context.params.platform || "").toLowerCase();
  const pattern = ASSET_PATTERNS[platform];
  if (!pattern) {
    return Response.redirect(RELEASES_PAGE, 302);
  }

  let release;
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: {
        "User-Agent": "lvisai.xyz-download-redirect",
        Accept: "application/vnd.github+json",
      },
      // Cache the API response briefly so bursts of clicks don't exhaust the
      // unauthenticated GitHub rate limit.
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`github api ${res.status}`);
    release = await res.json();
  } catch {
    return Response.redirect(RELEASES_PAGE, 302);
  }

  const asset = (release.assets || []).find((a) => pattern.test(a.name));
  return Response.redirect(asset ? asset.browser_download_url : RELEASES_PAGE, 302);
}
