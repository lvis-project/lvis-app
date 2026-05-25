// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkGroup } from "../WorkGroup.js";

describe("WorkGroup memo boundary", () => {
  afterEach(() => cleanup());

  it("keeps historical groups stable when only rebuilt children identity changes", () => {
    let childRenders = 0;
    function Child({ label }: { label: string }) {
      childRenders += 1;
      return <div>{label}</div>;
    }

    const view = render(
      <WorkGroup stepCount={1} streaming={false} revision="stable">
        <Child label="first" />
      </WorkGroup>,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("first")).toBeTruthy();
    expect(childRenders).toBe(1);

    view.rerender(
      <WorkGroup stepCount={1} streaming={false} revision="stable">
        <Child label="rebuilt" />
      </WorkGroup>,
    );

    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.queryByText("rebuilt")).toBeNull();
    expect(childRenders).toBe(1);

    view.rerender(
      <WorkGroup stepCount={1} streaming={false} revision="changed">
        <Child label="rebuilt" />
      </WorkGroup>,
    );

    expect(screen.getByText("rebuilt")).toBeTruthy();
    expect(childRenders).toBe(2);
  });
});
