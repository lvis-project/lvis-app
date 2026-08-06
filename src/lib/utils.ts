import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The theme declares its own type scale as `--text-body`, `--text-body-sm`,
 * `--text-caption` and `--text-micro` (the `@theme` block in styles.css),
 * which Tailwind turns into `text-body`, `text-body-sm`, `text-caption`,
 * `text-micro`.
 *
 * tailwind-merge only knows the stock font-size scale, so it filed these under
 * `text-color` and treated them as conflicting with real colour utilities. A
 * solid Button written as
 *
 *   <Button className="text-caption">   // variant supplies text-primary-foreground
 *
 * therefore lost `text-primary-foreground` outright and inherited the ambient
 * colour — a dark label on a near-black button, i.e. an unreadable blank pill.
 * That is what emptied the composer's send button and the edit bubble's save
 * button.
 *
 * Registering the scale keeps size and colour in separate conflict groups.
 */
const TYPE_SCALE = ["body", "body-sm", "caption", "micro"];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: TYPE_SCALE }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
