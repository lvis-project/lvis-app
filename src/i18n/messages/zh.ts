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
  "mainDialog.importConversationTitle": "导入会话",
};
