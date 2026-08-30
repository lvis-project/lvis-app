/**
 * Floating dock bootstrap — host-owned, and external for the same CSP reason
 * `plugin-ui-shell.js` is.
 *
 * The document declares `script-src 'self'` with no `'unsafe-inline'` and no
 * nonce, so an inline module block would be silently refused — which for a
 * transparent window means an invisible failure with no error text anywhere.
 * This sibling file loads under `'self'` without weakening the policy.
 *
 * WHAT IT DOES. Paints the host's activity line, and mounts one `<webview>`
 * per attached plugin card. The mount handshake is the sidebar's, unchanged:
 * `ensurePartition` first so the guest's loader table has the `lvis-plugin:`
 * scheme before it exists, then attach, then `registerWebview` so the shell's
 * `getEntryUrl()` can be answered.
 *
 * WHAT IT DOES NOT DO. Decide anything. Heights, order and lifetime are main's
 * — this file renders what it is told and reports what the user did.
 */

const dock = window.lvisDock;

const els = {
  activity: document.getElementById("activity"),
  conversation: document.getElementById("conversation"),
  summary: document.getElementById("summary"),
  detail: document.getElementById("detail"),
  bar: document.getElementById("bar"),
  barFill: document.querySelector("#bar > i"),
  slots: document.getElementById("slots"),
  empty: document.getElementById("empty"),
  close: document.getElementById("close"),
};

if (!dock) {
  // Without the bridge nothing here can work. Say so in the window rather than
  // leaving a blank always-on-top rectangle the user cannot explain.
  els.empty.hidden = false;
  els.empty.textContent = "[lvis] dock bridge missing.";
} else {
  main();
}

function main() {
  els.close.addEventListener("click", () => dock.requestClose());

  applyTheme();

  dock.onActivity((activity) => {
    if (!activity || typeof activity.summary !== "string") {
      els.activity.hidden = true;
      els.bar.hidden = true;
      return;
    }
    els.activity.hidden = false;
    // `textContent`, never `innerHTML`. The summary is host-composed today,
    // but a status line is exactly the kind of string that later gets a
    // plugin-supplied fragment in it, and the difference must not depend on
    // remembering.
    els.summary.textContent = activity.summary;
    // Which conversation the line belongs to. One line, up to four
    // conversations: without the name the user cannot tell whose progress
    // this is, and cannot tell that the previous line was replaced.
    const conversation = typeof activity.conversation === "string" ? activity.conversation : "";
    els.conversation.textContent = conversation;
    els.conversation.hidden = conversation.length === 0;
    const detail = typeof activity.detail === "string" ? activity.detail : "";
    els.detail.textContent = detail;
    els.detail.hidden = detail.length === 0;

    const progress = activity.progress;
    if (typeof progress === "number" && Number.isFinite(progress)) {
      els.bar.hidden = false;
      els.barFill.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
    } else {
      els.bar.hidden = true;
    }
  });

  dock.onMount((slot) => {
    void mountSlot(slot);
  });

  dock.onResize(({ panelId, height }) => {
    const el = document.getElementById(slotElementId(panelId));
    if (el) el.style.height = `${height}px`;
  });

  dock.onUnmount(({ panelId }) => {
    document.getElementById(slotElementId(panelId))?.remove();
  });
}

function slotElementId(panelId) {
  return `slot-${panelId}`;
}

async function applyTheme() {
  try {
    const theme = await dock.getTheme();
    const tokens = theme && typeof theme === "object" ? theme.tokens : null;
    if (!tokens || typeof tokens !== "object") return;
    // Only the tokens this window actually uses. Copying the whole map onto a
    // surface with five colours in it would make the dock's appearance depend
    // on tokens nobody checked against a transparent background.
    const pick = {
      "--dock-fg": tokens["--lvis-fg"],
      "--dock-bg": tokens["--lvis-bg-elevated"] ?? tokens["--lvis-bg"],
      "--dock-border": tokens["--lvis-border"],
      "--dock-accent": tokens["--lvis-accent"],
    };
    for (const [name, value] of Object.entries(pick)) {
      if (typeof value === "string" && value) document.documentElement.style.setProperty(name, value);
    }
  } catch {
    // The stylesheet's fallbacks already cover this. A dock that refused to
    // paint because the theme was not ready would be worse than one in
    // default colours.
  }
}

async function mountSlot({ panelId, pluginId, entryUrl, partition, title, height }) {
  if (document.getElementById(slotElementId(panelId))) return;

  const slot = document.createElement("div");
  slot.className = "slot";
  slot.id = slotElementId(panelId);
  slot.style.height = `${height}px`;
  slot.style.flex = `0 0 ${height}px`;

  const head = document.createElement("div");
  head.className = "slot-head";
  const label = document.createElement("span");
  label.className = "slot-title";
  // The plugin's string, placed as TEXT inside the host's chrome. A title is a
  // label, not a way to draw into the host's frame.
  label.textContent = typeof title === "string" ? title : pluginId;
  head.appendChild(label);
  slot.appendChild(head);

  els.slots.appendChild(slot);

  // BEFORE the guest exists. A frame binds its URL loaders once, at first
  // load, so a scheme installed after that point is unreachable from it for
  // the frame's whole life — the failure mode is a card that can never fetch
  // its own assets and cannot be fixed by retrying.
  try {
    await dock.ensurePartition(pluginId);
  } catch {
    label.textContent = `${label.textContent} — unavailable`;
    return;
  }

  const view = document.createElement("webview");
  view.setAttribute("src", dock.pluginShellUrl);
  view.setAttribute("preload", dock.pluginPreloadUrl);
  // Main's, verbatim. The name is a hash of the plugin id and this file
  // deliberately does not know the rule — see the surface's comment.
  view.setAttribute("partition", partition);
  view.setAttribute("allowpopups", "false");
  slot.appendChild(view);

  view.addEventListener("did-attach", () => {
    // Main re-validates `entryUrl` against the plugin's install root and
    // refuses anything outside it, so this call is a request rather than an
    // assertion — the dock renderer asking is not the dock renderer being
    // trusted.
    void dock
      .registerWebview({ webContentsId: view.getWebContentsId(), pluginId, entryUrl })
      .catch(() => {
        label.textContent = `${label.textContent} — failed to load`;
      });
  });

  // A guest that dies leaves a slot the host still believes is live. Report it
  // so the plugin hears `renderer-gone` and can clean up whatever the card was
  // driving.
  for (const event of ["crashed", "destroyed", "render-process-gone"]) {
    view.addEventListener(event, () => dock.reportSlotGone(panelId));
  }
}
