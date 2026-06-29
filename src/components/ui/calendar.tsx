import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { de, enUS, es, fr, ja, ko, zhCN } from "date-fns/locale";

import { cn } from "../../lib/utils.js";
import { useTranslation } from "../../i18n/react.js";
import { buttonVariants } from "./button.js";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

const DATE_FNS_LOCALES = {
  en: enUS,
  ko,
  ja,
  zh: zhCN,
  es,
  fr,
  de,
} as const;

/**
 * shadcn-style Calendar wrapper around react-day-picker v9, customized to
 * the app theme tokens and active app locale, Sunday-first.
 */
export function Calendar({
  className,
  classNames,
  locale: localeOverride,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  const { locale } = useTranslation();

  return (
    <DayPicker
      locale={localeOverride ?? DATE_FNS_LOCALES[locale]}
      weekStartsOn={0}
      showOutsideDays={showOutsideDays}
      className={cn("relative p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-2",
        month: "flex flex-col gap-2",
        month_caption: "flex items-center px-1 pb-1 pt-1 pr-16",
        caption_label: "text-xs font-semibold",
        // Nav is a sibling of <Months>, so absolute-position it onto the
        // caption row to land on the same line as the label. wrapper has
        // `relative` so right/top resolve to the calendar's outer edges.
        nav: "absolute right-2 top-2 flex items-center gap-1",
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "h-7 w-7 rounded-full border-border bg-muted/30 p-0 opacity-80 hover:bg-accent hover:opacity-100",
        ),
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "h-7 w-7 rounded-full border-border bg-muted/30 p-0 opacity-80 hover:bg-accent hover:opacity-100",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-8 rounded-md text-[11px] font-medium text-muted-foreground",
        week: "flex w-full mt-0.5",
        day: "relative h-8 w-8 p-0 text-center text-xs",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-8 w-8 rounded-full p-0 text-xs font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground",
        ),
        selected:
          "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground [&>button]:rounded-full",
        today: "[&>button]:text-primary [&>button]:font-semibold",
        outside: "[&>button]:text-muted-foreground/40",
        disabled: "[&>button]:text-muted-foreground/40",
        range_middle: "[&>button]:bg-primary/15 [&>button]:text-primary",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          ),
      }}
      {...props}
    />
  );
}
