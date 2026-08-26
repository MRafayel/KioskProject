// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { Panel } from "./components.js";

afterEach(cleanup);

describe("Panel request failures", () => {
  it("keeps one retry beside one error and explains when stale information remains", () => {
    const reload = vi.fn();

    render(
      <Panel
        title="Recent records"
        state={{
          data: { items: [] },
          loading: false,
          error: "The latest request failed.",
          reload
        }}
      >
        <p>Previously loaded content</p>
      </Panel>
    );

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The latest request failed. Showing the last information that loaded."
    );
    expect(screen.getByText("Previously loaded content")).toBeVisible();
  });
});
