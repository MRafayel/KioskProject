// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { PrototypeSessionProvider } from "../features/session/PrototypeSessionProvider.js";
import { initialPrototypeState, type PrototypeState } from "../features/session/model.js";
import { App } from "./App.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("kiosk prototype journey", () => {
  it("moves from welcome through upload, settings, and checkout", async () => {
    const user = userEvent.setup();
    renderKiosk();

    await user.click(screen.getByRole("button", { name: "Start printing" }));
    expect(await screen.findByRole("heading", { name: "Upload your document" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Simulate phone upload" }));
    expect(await screen.findByText("sample-document.pdf")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Continue to print settings/i }));
    expect(screen.getByRole("heading", { name: "Choose print settings" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Increase copies" }));
    await user.click(screen.getByLabelText("Double-sided"));
    expect(screen.getByText("$2.40")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Review and pay/i }));
    expect(screen.getByRole("heading", { name: "Review and pay" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Pay $2.40" })).toBeEnabled();
  });

  it("cancels safely and returns to the only available service", async () => {
    const user = userEvent.setup();
    renderKiosk();

    await user.click(screen.getByRole("button", { name: "Start printing" }));
    await screen.findByRole("heading", { name: "Upload your document" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("dialog", { name: "Cancel this print session?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel session" }));
    expect(screen.getByRole("heading", { name: /Print from your phone/i })).toBeVisible();
    expect(screen.queryByText(/scan documents|xerox|color printing/i)).not.toBeInTheDocument();
  });

  it("warns on inactivity and resets the private session", async () => {
    vi.useFakeTimers();
    renderKiosk({
      initialEntries: ["/upload"],
      initialState: {
        ...initialPrototypeState,
        session: {
          id: "idle-test-session",
          shortCode: "123 456",
          uploadUrl: "https://upload.example.test/idle-test-session",
          expiresAt: "2030-01-01T00:00:00.000Z"
        }
      }
    });

    await act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("alertdialog", { name: "Do you need more time?" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(screen.getByRole("heading", { name: /Print from your phone/i })).toBeVisible();
  });
});

function renderKiosk({
  initialEntries = ["/"],
  initialState = initialPrototypeState
}: {
  initialEntries?: string[];
  initialState?: PrototypeState;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <PrototypeSessionProvider initialState={initialState}>
        <MemoryRouter initialEntries={initialEntries}>
          <App />
        </MemoryRouter>
      </PrototypeSessionProvider>
    </QueryClientProvider>
  );
}
