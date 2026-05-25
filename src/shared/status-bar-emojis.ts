export const STATUS_BAR_RUNTIME_EMOJIS = {
  tools: "🔧",
  plugins: "🧩",
  mcps: "🔌",
} as const;

export const STATUS_BAR_OS_EMOJIS = {
  darwin: "🍎",
  win32: "🪟",
  linux: "🐧",
  fallback: "💻",
} as const;

export const STATUS_BAR_VENDOR_EMOJIS = {
  claude: "🟧",
  openai: "🟦",
  gemini: "🟢",
  copilot: "🐙",
  azureFoundry: "🔷",
  vertexAi: "🟣",
  fallback: "🤖",
} as const;

export const STATUS_BAR_IDENTITY_EMOJIS = [
  STATUS_BAR_RUNTIME_EMOJIS.tools,
  STATUS_BAR_RUNTIME_EMOJIS.plugins,
  STATUS_BAR_RUNTIME_EMOJIS.mcps,
  STATUS_BAR_OS_EMOJIS.darwin,
  STATUS_BAR_OS_EMOJIS.win32,
  STATUS_BAR_OS_EMOJIS.linux,
  STATUS_BAR_OS_EMOJIS.fallback,
  STATUS_BAR_VENDOR_EMOJIS.claude,
  STATUS_BAR_VENDOR_EMOJIS.openai,
  STATUS_BAR_VENDOR_EMOJIS.gemini,
  STATUS_BAR_VENDOR_EMOJIS.copilot,
  STATUS_BAR_VENDOR_EMOJIS.azureFoundry,
  STATUS_BAR_VENDOR_EMOJIS.vertexAi,
  STATUS_BAR_VENDOR_EMOJIS.fallback,
] as const;
