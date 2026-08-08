// i18n. Source: src/ui/renderer/components/ViewPathNav.tsx.
export const en = {
  "viewPathNav.back": "Back",
  "viewPathNav.backTo": "Back to {label}",
  "viewPathNav.forward": "Forward",
  "viewPathNav.forwardTo": "Forward to {label}",
  "viewPathNav.ariaLabel": "Current location",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "viewPathNav.back": "뒤로",
  "viewPathNav.backTo": "{label}(으)로 뒤로",
  "viewPathNav.forward": "앞으로",
  "viewPathNav.forwardTo": "{label}(으)로 앞으로",
  "viewPathNav.ariaLabel": "현재 위치",
};
