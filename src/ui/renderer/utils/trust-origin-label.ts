import { t } from "../../../i18n/runtime.js";

export function trustOriginLabel(origin: string | undefined): string {
  switch (origin) {
    case "user-keyboard":
      return t("trustOriginLabel.userKeyboard");
    case "plugin-emitted":
      return t("trustOriginLabel.pluginEmitted");
    case "llm-tool-arg":
      return t("trustOriginLabel.llmToolArg");
    case "file-content":
      return t("trustOriginLabel.fileContent");
    case undefined:
      return t("trustOriginLabel.unknown");
    default:
      return origin;
  }
}

export function isNonUserTrustOrigin(origin: string | undefined): boolean {
  return origin !== "user-keyboard";
}
