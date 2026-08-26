// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { Distribution, FilterKpi, Kpi } from "./surfaces.js";

afterEach(cleanup);

describe("KPI behavior cues", () => {
  it("distinguishes summaries, navigation, and table filters without relying on hover", async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    const onChoose = vi.fn();

    const { rerender } = render(
      <>
        <Kpi label="Occurrences" value={12} foot="across 3 groups" />
        <Kpi label="Kiosks" value={4} onOpen={onView} openLabel="Show kiosks." />
        <Kpi label="Refunds" value={3} onOpen={onView} behavior="view" />
        <FilterKpi
          card="FAILED"
          label="Failed"
          noun="print jobs"
          value={2}
          resting="Latest loaded jobs"
          active={null}
          onChoose={onChoose}
        />
      </>
    );

    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("View page →")).toBeInTheDocument();
    expect(screen.getByText("Open view")).toBeInTheDocument();
    expect(screen.getByText("Filter table")).toBeInTheDocument();

    const filter = screen.getByRole("button", { name: /^Failed: 2\./ });
    expect(filter).toHaveAttribute("aria-pressed", "false");
    await user.click(filter);
    expect(onChoose).toHaveBeenCalledWith("FAILED");

    rerender(
      <FilterKpi
        card="FAILED"
        label="Failed"
        noun="print jobs"
        value={2}
        resting="Latest loaded jobs"
        active="FAILED"
        onChoose={onChoose}
      />
    );

    expect(screen.getByText("Filtering table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Failed: 2\./ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});

describe("a distribution", () => {
  it("takes its shares from the total it was given, not from the rows it drew", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();

    // A truncated list: two kiosks named out of a page of fifty payments. A
    // percentage computed from the rows present would read 60/40 and would be a
    // statement about the list rather than about the page.
    render(
      <Distribution
        label="Payments by kiosk"
        total={50}
        scope="Counted from the 50 payments on this page."
        rows={[
          { id: "a", label: "Kiosk A", value: 30, onOpen, openLabel: "Show kiosk A." },
          { id: "b", label: "Kiosk B", value: 20, note: "1 failed here" }
        ]}
      />
    );

    expect(
      screen.getByRole("button", { name: "Kiosk A: 30, 60% of 50. Show kiosk A." })
    ).toBeVisible();
    expect(screen.getByText("40%")).toBeVisible();
    // The denominator is on screen in words, not only in the accessible name.
    expect(screen.getByText("Counted from the 50 payments on this page.")).toBeVisible();
    // A row with nowhere to go is not a control.
    expect(screen.queryByRole("button", { name: /Kiosk B/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Kiosk A/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("draws no percentage at all when there is no total to be a share of", () => {
    render(
      <Distribution
        label="Payments by kiosk"
        total={0}
        rows={[{ id: "a", label: "A", value: 0 }]}
      />
    );

    expect(screen.queryByText("%", { exact: false })).toBeNull();
  });
});
