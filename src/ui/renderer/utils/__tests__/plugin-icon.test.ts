import { describe, expect, it } from "vitest";
import { pluginIconFor } from "../plugin-icon.js";
import * as LucideIcons from "lucide-react";

describe("pluginIconFor", () => {
  it("returns the Lucide icon matching the name", () => {
    const result = pluginIconFor({ icon: "Mic" });
    expect(result).toBe(LucideIcons.Mic);
  });

  it("returns Plug for unknown icon names", () => {
    const result = pluginIconFor({ icon: "NonExistentIconXyz" });
    expect(result).toBe(LucideIcons.Plug);
  });

  it("returns Plug when icon is undefined", () => {
    const result = pluginIconFor({});
    expect(result).toBe(LucideIcons.Plug);
  });

  it("returns FileText for 'FileText'", () => {
    const result = pluginIconFor({ icon: "FileText" });
    expect(result).toBe(LucideIcons.FileText);
  });

  it("returns Share2 for 'Share2'", () => {
    const result = pluginIconFor({ icon: "Share2" });
    expect(result).toBe(LucideIcons.Share2);
  });
});
