/**
 * Simplified Chinese message catalog. Mirrors every key in ./en.
 */
import type { SeedMessageKey } from "./en.js";

export const zh: Record<SeedMessageKey, string> = {
  // Common / shared
  "common.cancel": "取消",
  "common.allow": "允许",
  "common.confirm": "确认",
  "common.ok": "确定",
  "common.save": "保存",
  "common.close": "关闭",
  "common.delete": "删除",
  "common.remove": "移除",
  "common.retry": "重试",
  "common.loading": "正在加载…",
  "common.error": "错误",
  "common.thinking": "正在思考…",

  // Settings > Appearance > Language
  "settings.appearance.language.title": "语言",
  "settings.appearance.language.description":
    "选择整个应用使用的语言。更改会立即生效。",
  "settings.appearance.language.saved": "语言已更新。",

  // Main-process dialogs / menus / notifications
  "mainDialog.restart": "重启",
  "mainDialog.updateApplyTitle": "应用更新",
  "mainDialog.updateRestartMessage": "LVIS 将重启到 v{version}。",
  "mainDialog.updateRestartDetail": "正在进行的工作将结束。要继续吗？",
  "mainDialog.attachTitle": "选择附件文件",
  "mainDialog.installLocalPluginTitle": "安装本地插件 (开发者)",
  "mainDialog.installLocalPluginMessage": "请选择包含 plugin.json 的构建文件夹",
  "mainDialog.unauthorizedFrame": "未经授权的框架。",
  "mainDialog.noPersonasAvailable": "没有可用的 persona",
  "mainDialog.exportConversationTitle": "导出会话",

  // ── E4 — 启动 / 全局快捷键 ────────────────────────────────────────
  "settingsContent.tabStartup": "启动",
  "startupTab.title": "启动与快捷键",
  "startupTab.description":
    "设置一个用于显示/隐藏窗口的全局快捷键，并选择 LVIS 是否在登录时启动。",
  "startupTab.shortcutSectionTitle": "全局快捷键",
  "startupTab.shortcutSectionDesc":
    "一个系统级的组合键，可从任何位置显示或隐藏 LVIS 窗口。",
  "startupTab.shortcutEnabledLabel": "启用全局快捷键",
  "startupTab.shortcutEnabledHint": "将快捷键注册到操作系统。",
  "startupTab.shortcutAcceleratorLabel": "显示/隐藏窗口快捷键",
  "startupTab.shortcutRecord": "录制",
  "startupTab.shortcutClear": "清除",
  "startupTab.shortcutCapturing": "请按下组合键…",
  "startupTab.shortcutUnset": "未设置",
  "startupTab.shortcutEnabledNoAccelerator":
    "快捷键已启用但未设置组合键。请录制一个以激活它。",
  "startupTab.shortcutRegisterFailedTitle": "快捷键注册失败",
  "startupTab.shortcutRegisterFailedBody":
    "{accelerator} 已被其他应用占用。请选择其他组合。",
  "startupTab.launchSectionTitle": "开机自动启动",
  "startupTab.launchSectionDesc":
    "控制在登录到计算机时是否自动启动 LVIS。",
  "startupTab.launchAtStartupLabel": "登录时启动 LVIS",
  "startupTab.launchAtStartupHint": "登录后自动启动 LVIS。（仅限已安装的应用）",
  "startupTab.launchMinimizedLabel": "启动时隐藏到托盘",
  "startupTab.launchMinimizedHint": "在登录启动时，最小化到托盘启动而不打开窗口。",
  "startupTab.launchRegisterFailedTitle": "无法应用开机自动启动",
  "startupTab.launchRegisterFailedBody":
    "LVIS 无法在此系统上注册登录时自动启动。请打开设置重试。",
};
