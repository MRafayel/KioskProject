// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { LanguageProvider } from "../features/i18n/LanguageProvider.js";
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
    await user.click(screen.getByRole("button", { name: "English" }));

    await user.click(screen.getByRole("button", { name: "Start printing" }));
    expect(await screen.findByRole("heading", { name: "Upload your document" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Simulate phone upload" }));
    expect(await screen.findByText("sample-document.pdf")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Continue to print settings/i }));
    expect(screen.getByRole("heading", { name: "Choose print settings" })).toBeVisible();
    expect(screen.queryByText("Paper size", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Pages per side", { exact: true })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("spinbutton", { name: "From page" }), {
      target: { value: "3" }
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "To page" }), {
      target: { value: "7" }
    });

    await user.click(screen.getByRole("button", { name: "Increase copies" }));
    await user.click(screen.getByLabelText("Double-sided"));
    expect(screen.getByText("$1.50")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Review and pay/i }));
    expect(screen.getByRole("heading", { name: "Review and pay" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Pay $1.50" })).toBeEnabled();
  });

  it("cancels safely and returns to the only available service", async () => {
    const user = userEvent.setup();
    renderKiosk();
    await user.click(screen.getByRole("button", { name: "English" }));

    await user.click(screen.getByRole("button", { name: "Start printing" }));
    await screen.findByRole("heading", { name: "Upload your document" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("dialog", { name: "Cancel this print session?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel session" }));
    expect(screen.getByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
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

    expect(screen.getByRole("timer", { name: "Մնացել է 120 վայրկյան" })).toBeVisible();
    await act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("timer", { name: "Մնացել է 110 վայրկյան" })).toBeVisible();

    fireEvent.pointerDown(screen.getByRole("heading", { name: "Վերբեռնեք փաստաթուղթը" }));
    expect(screen.getByRole("timer", { name: "Մնացել է 120 վայրկյան" })).toBeVisible();

    await act(() => vi.advanceTimersByTime(90_000));
    expect(screen.getByRole("alertdialog", { name: "Ավելի շատ ժամանա՞կ է պետք։" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Ավարտել գործողությունը" }));
    expect(screen.getByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
  });

  it("shows only the two alternative languages and resets to Armenian for the next customer", async () => {
    const user = userEvent.setup();
    renderKiosk();

    expect(document.documentElement).toHaveAttribute("lang", "hy");
    expect(
      screen.getByRole("heading", { name: "Տպեք հեռախոսից՝ ընդամենը մի քանի քայլով։" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "English" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Русский" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Հայերեն" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Русский" }));
    expect(document.documentElement).toHaveAttribute("lang", "ru");
    expect(
      screen.getByRole("heading", { name: "Печатайте с телефона за несколько простых шагов." })
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Начать печать" }));
    expect(await screen.findByRole("heading", { name: "Загрузите документ" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "English" }));
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(screen.getByRole("heading", { name: "Upload your document" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Cancel this print session?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel session" }));

    expect(document.documentElement).toHaveAttribute("lang", "hy");
    expect(screen.getByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
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
    <LanguageProvider>
      <QueryClientProvider client={queryClient}>
        <PrototypeSessionProvider initialState={initialState}>
          <MemoryRouter initialEntries={initialEntries}>
            <App />
          </MemoryRouter>
        </PrototypeSessionProvider>
      </QueryClientProvider>
    </LanguageProvider>
  );
}
