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
  "mainDialog.pluginDisableNotPermitted": "此插件由您的组织管理，无法停用。",
  "mainDialog.noPersonasAvailable": "没有可用的 persona",
  "mainDialog.exportConversationTitle": "导出会话",
  "mainDialog.importConversationTitle": "导入会话",

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
  "startupTab.renderingSectionTitle":
    "界面渲染",
  "startupTab.renderingSectionDesc":
    "控制 LVIS 绘制界面时是否使用显卡。",
  "startupTab.hardwareAccelerationLabel":
    "使用硬件加速",
  "startupTab.hardwareAccelerationHelp":
    "下次启动 LVIS 时生效。如果窗口变黑、闪烁，或应用在绘制时崩溃，请关闭此项 — 部分受管电脑和虚拟桌面的显卡驱动无法支持它。因此在 Windows 和 Linux 上默认关闭。",
  "startupTab.hardwareAccelerationEnvForced":
    "环境变量 {envVar} 正在开启此项，与这里保存的值无关。",
  "startupTab.corpCaSectionTitle":
    "企业网络证书",
  "startupTab.corpCaSectionDesc":
    "适用于使用公司颁发的根证书检查 TLS 流量的网络。",
  "startupTab.corpCaEnabledLabel":
    "信任企业根证书",
  "startupTab.corpCaEnabledHelp":
    "下次启动 LVIS 时生效。浏览网页时 LVIS 沿用操作系统信任的证书，但模型调用、应用商店请求和更新检查会单独验证，并不沿用。在检查 TLS 流量的网络中，正是这些请求会因证书错误而失败，而普通网页却能正常打开；此设置就是用来解决该问题的。不确定时请保持开启 — 在没有这类证书的电脑上，它什么也找不到，也不会改变任何东西。",
  "startupTab.corpCaEnabledEnvForced":
    "环境变量 {envVar} 正在关闭此项，与这里保存的值无关。",
  "startupTab.corpCaCommonNameLabel":
    "证书名称",
  "startupTab.corpCaCommonNameHelp":
    "公司根证书在系统信任存储中的通用名称 (CN)。下面的默认值只是占位示例 — 如果证书错误仍然存在，请向公司 IT 部门确认真实名称。填写名称的一部分即可匹配。",
  "startupTab.corpCaCommonNameEnvForced":
    "环境变量 {envVar} 正在代替这里保存的值提供该名称。",
  "startupTab.corpCaDebugLabel":
    "记录证书查找详情",
  "startupTab.corpCaDebugHelp":
    "把查找了什么、找到了什么写入应用日志。仅在排查证书问题时开启。",
  "startupTab.corpCaDebugEnvForced":
    "环境变量 {envVar} 正在开启此项，与这里保存的值无关。",
  "startupTab.launchSectionTitle": "开机自动启动",
  "startupTab.launchSectionDesc":
    "控制在登录到计算机时是否自动启动 LVIS。",
  "startupTab.launchAtStartupLabel": "登录时启动 LVIS",
  "startupTab.launchAtStartupHint": "登录后自动启动 LVIS。（仅限已安装的应用）",
  "startupTab.launchMinimizedLabel": "启动时隐藏到托盘",
  "startupTab.launchMinimizedHint": "在登录启动时，最小化到托盘启动而不打开窗口。",
  "startupTab.launchRegisterFailedTitle": "无法应用开机自动启动",
  "startupTab.shutdownTimeoutLabel":
    "退出时允许的清理时间",
  "startupTab.shutdownTimeoutHelp":
    "退出时,LVIS 会停止例程、插件和后台进程并保存窗口布局,然后关闭。如果在此时间内未完成,它仍会关闭,尚未写完的内容将被丢弃。若某个插件需要更长时间关闭请调大,若觉得退出缓慢请调小。",
  "startupTab.shutdownTimeoutEnvForced":
    "环境变量 {envVar} 当前正在提供此值,而不是这里保存的值。",
  "startupTab.shutdownTimeoutSeconds": "{seconds} 秒",
  "startupTab.shutdownTimeoutSecondsDefault": "{seconds} 秒 (默认)",
  "startupTab.launchRegisterFailedBody":
    "LVIS 无法在此系统上注册登录时自动启动。请打开设置重试。",
};
