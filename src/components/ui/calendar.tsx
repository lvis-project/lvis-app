import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { ko } from "date-fns/locale";

import { cn } from "../../lib/utils.js";
import { buttonVariants } from "./button.js";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

/**
 * shadcn-style Calendar wrapper around react-day-picker v9, customized to
 * the LVIS palette: today/selected = #FD312E filled circle, surface = warm
 * grey card, ko-KR + Sunday-first.
 *
 * UI-only for now — caller wires `selected` / `onSelect` whenever the
 * date-jump feature lands.
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      locale={ko}
      weekStartsOn={0}
      showOutsideDays={showOutsideDays}
      className={cn("p-3 relative", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-2",
        month: "flex flex-col gap-2",
        month_caption: "flex pt-1 pb-1 px-1 items-center",
        caption_label: "text-xs font-semibold",
        // Nav is a sibling of <Months>, so absolute-position it onto the
        // caption row to land on the same line as the label. wrapper has
        // `relative` so right/top resolve to the calendar's outer edges.
        nav: "flex items-center gap-1 absolute right-3 top-3",
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "h-6 w-6 bg-transparent p-0 opacity-70 hover:opacity-100",
        ),
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "h-6 w-6 bg-transparent p-0 opacity-70 hover:opacity-100",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "text-foreground rounded-md w-7 font-extrabold text-[11px]",
        week: "flex w-full mt-0.5",
        day: "h-7 w-7 text-center text-xs p-0 relative",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-7 w-7 p-0 text-xs font-normal hover:bg-[#FD312E]/15 rounded-full",
        ),
        selected:
          "[&>button]:bg-[#FD312E] [&>button]:text-white [&>button]:hover:bg-[#FD312E] [&>button]:hover:text-white [&>button]:rounded-full",
        today: "[&>button]:bg-[#FD312E]/15 [&>button]:text-[#FD312E] [&>button]:font-semibold",
        outside: "[&>button]:text-muted-foreground/40",
        disabled: "[&>button]:text-muted-foreground/40",
        range_middle: "[&>button]:bg-[#FD312E]/15 [&>button]:text-[#FD312E]",
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
