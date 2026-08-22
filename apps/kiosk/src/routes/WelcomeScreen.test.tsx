// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App.js";
import { DEFAULT_LOCALE, LanguageProvider } from "../features/i18n/LanguageProvider.js";
import { messages as catalogues } from "../features/i18n/messages.js";
import { PrototypeSessionProvider } from "../features/session/PrototypeSessionProvider.js";

/**
 * A kiosk whose printer cannot finish a job must not offer to start one.
 *
 * The refusal already exists on the server, and it always did — this is about
 * the twenty seconds before a customer meets it. Somebody who has photographed
 * a QR code and uploaded their documents has lost more than the refusal costs to
 * prevent, so the screen closes itself first.
 *
 * The rule it must hold in both directions: close on a definite negative, and
 * never close on anything else — not a warning the printer can still print
 * through, and not an agent that was briefly slow to answer.
 */

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // Auto-cleanup is not enabled in this project, so a dialog left mounted would
  // be found by the next test and quietly assert against the wrong render.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function availability(body: { available: boolean; reason?: string | null }) {
  return Promise.resolve(
    new Response(
      JSON.stringify({ availability: { available: body.available, reason: body.reason ?? null } }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
}

function renderWelcome() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
  });
  return render(
    <LanguageProvider>
      <QueryClientProvider client={queryClient}>
        <PrototypeSessionProvider>
          <App initialPath="/" />
        </PrototypeSessionProvider>
      </QueryClientProvider>
    </LanguageProvider>
  );
}

// The screen boots in the kiosk's own default language, so the assertions read
// the same catalogue the component does rather than assuming English.
const copy = catalogues[DEFAULT_LOCALE];
const startButton = () => screen.getByRole("button", { name: new RegExp(copy.welcome.start, "i") });

describe("a kiosk that cannot print closes itself", () => {
  it("covers the screen and disables the button when the printer is offline", async () => {
    fetchMock.mockImplementation(() => availability({ available: false, reason: "PRINTER_OFFLINE" }));
    renderWelcome();

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent ?? "").toContain(copy.welcome.printerUnavailableError);
    // Covered *and* disabled: a button behind an overlay is still reachable by
    // a stray tap or a keyboard.
    expect(startButton().hasAttribute("disabled")).toBe(true);
  });

  it("names the paper when the printer said so, and guesses at nothing else", async () => {
    fetchMock.mockImplementation(() =>
      availability({ available: false, reason: "PRINTER_OUT_OF_PAPER" })
    );
    renderWelcome();

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent ?? "").toContain(copy.welcome.printerOutOfPaperError);
  });

  it("gives no way out of the dialog", async () => {
    fetchMock.mockImplementation(() => availability({ available: false, reason: "PRINTER_OFFLINE" }));
    renderWelcome();
    const dialog = await screen.findByRole("alertdialog");

    // No close control of any kind inside it.
    expect(dialog.querySelector("button")).toBeNull();

    // Escape closes every other dialog in this app. Not this one: there is no
    // choice to make, and dismissing it would leave a Start button that can
    // only refuse.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeNull();

    // Nor does pressing the backdrop around it.
    await userEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.queryByRole("alertdialog")).not.toBeNull();
  });
});

describe("a kiosk that can print stays open", () => {
  it("shows no dialog while the printer is healthy", async () => {
    fetchMock.mockImplementation(() => availability({ available: true }));
    renderWelcome();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(startButton().hasAttribute("disabled")).toBe(false);
  });

  it("stays open through a warning the printer can still print through", async () => {
    // Toner running down, a tray that will need paper. The gate reports these
    // as available, and closing the kiosk for one would cost real prints.
    fetchMock.mockImplementation(() => availability({ available: true, reason: null }));
    renderWelcome();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("stays open when the agent cannot be reached", async () => {
    // Only an answer that actually arrived may shut the screen. A wrong
    // optimistic answer costs the refusal the customer would have had anyway;
    // a wrong pessimistic one closes a working kiosk because a proxy was slow.
    fetchMock.mockImplementation(() => Promise.reject(new Error("network")));
    renderWelcome();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(startButton().hasAttribute("disabled")).toBe(false);
  });

  it("reopens on its own once somebody refills the tray", async () => {
    let empty = true;
    fetchMock.mockImplementation(() =>
      empty ? availability({ available: false, reason: "PRINTER_OUT_OF_PAPER" }) : availability({ available: true })
    );
    renderWelcome();
    await screen.findByRole("alertdialog");

    empty = false;

    // No reload, no tap: the screen re-asks and the dialog goes away by itself.
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), { timeout: 15_000 });
    expect(startButton().hasAttribute("disabled")).toBe(false);
    // Longer than the poll interval, because this is the real timer doing the
    // real thing: nobody reloaded and nobody pressed anything.
  }, 20_000);
});
