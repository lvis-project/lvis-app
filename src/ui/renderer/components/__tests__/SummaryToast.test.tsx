// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SummaryToast } from "../SummaryToast.js";

describe("SummaryToast", () => {
  it("renders compact summaries collapsed by default", () => {
    const { getByTestId } = render(<SummaryToast summary={"## 요약\n\n- 중요한 결정"} />);

    const details = getByTestId("summary-toast");
    expect(details.tagName.toLowerCase()).toBe("details");
    expect(details).not.toHaveAttribute("open");
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(getByTestId("summary-toast-body")).toBeInTheDocument();
  });
});
