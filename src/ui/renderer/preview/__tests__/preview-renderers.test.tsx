// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreviewContent, resolvePreviewRenderer } from "../preview-renderers.js";

describe("resolvePreviewRenderer", () => {
  it("picks markdown for .md / .markdown paths and text/markdown mime", () => {
    expect(resolvePreviewRenderer({ text: "", path: "/x/notes.md" }).kind).toBe("markdown");
    expect(resolvePreviewRenderer({ text: "", filename: "README.markdown" }).kind).toBe("markdown");
    expect(resolvePreviewRenderer({ text: "", mimeType: "text/markdown" }).kind).toBe("markdown");
  });

  it("picks mermaid for .mmd / .mermaid", () => {
    expect(resolvePreviewRenderer({ text: "", path: "/d/flow.mmd" }).kind).toBe("mermaid");
    expect(resolvePreviewRenderer({ text: "", filename: "graph.mermaid" }).kind).toBe("mermaid");
  });

  it("falls back to text for unknown / no extension", () => {
    expect(resolvePreviewRenderer({ text: "hello" }).kind).toBe("text");
    expect(resolvePreviewRenderer({ text: "", path: "/a/main.py" }).kind).toBe("text");
    expect(resolvePreviewRenderer({ text: "", filename: "output" }).kind).toBe("text");
  });

  it("renders markdown headings as HTML (not literal text)", () => {
    const { container } = render(
      <PreviewContent descriptor={{ text: "# Title\n\nbody", path: "doc.md" }} />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Title");
  });

  it("renders plain text in a pre block", () => {
    const { container } = render(<PreviewContent descriptor={{ text: "raw log line" }} />);
    expect(container.querySelector("pre")?.textContent).toBe("raw log line");
  });
});
