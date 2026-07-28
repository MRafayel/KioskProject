// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";

import { KioskRouterProvider, useKioskLocation } from "./router.js";

afterEach(cleanup);

describe("kiosk internal router boundary", () => {
  it.each([
    "https://example.invalid/steal-session",
    "//example.invalid/steal-session",
    "\\\\example.invalid\\steal-session",
    "/valid\0suffix",
    `/${"a".repeat(201)}`
  ])("fails closed to welcome for a non-internal path: %s", (path) => {
    render(
      <KioskRouterProvider initialPath={path}>
        <CurrentPath />
      </KioskRouterProvider>
    );

    expect(screen.getByTestId("current-path")).toHaveTextContent("/");
  });

  it("keeps a bounded internal path while removing query and fragment data", () => {
    render(
      <KioskRouterProvider initialPath="/upload?token=private#fragment">
        <CurrentPath />
      </KioskRouterProvider>
    );

    expect(screen.getByTestId("current-path")).toHaveTextContent("/upload");
    expect(screen.getByTestId("current-path")).not.toHaveTextContent("private");
  });
});

function CurrentPath() {
  const { pathname } = useKioskLocation();
  return <span data-testid="current-path">{pathname}</span>;
}
