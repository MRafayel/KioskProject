import { type Dispatch, useCallback, useEffect, useRef } from "react";

import type { PrintSettingsSnapshot } from "@printing-kiosk/contracts";

import type { PricingState, PrintSettings, PrototypeAction, ReadyPrototypeFile } from "./model.js";
import {
  buildSettingsBody,
  createKioskQuote,
  PricingRequestError,
  saveKioskSettings
} from "./pricingService.js";

const DEFAULT_DEBOUNCE_MS = 400;
const EXPIRY_CHECK_INTERVAL_MS = 1_000;

interface PricingInput {
  sessionId: string | null;
  sessionVersion: number;
  file: ReadyPrototypeFile | null;
  settings: PrintSettings;
  pricing: PricingState;
  dispatch: Dispatch<PrototypeAction>;
  debounceMilliseconds?: number;
}

interface SavedRevision {
  fingerprint: string;
  revision: number;
  snapshot: PrintSettingsSnapshot;
}

/**
 * Keeps the displayed price server-authoritative.
 *
 * Every change to the document set or the controls invalidates the local
 * pricing state, which brings the screen back to `IDLE`. This hook then saves
 * the settings, asks the control plane for a price, and stores only what the
 * control plane answered. The kiosk never calculates a total, and it never
 * shows a stale one: an expired quote drops the screen back to `IDLE` so a
 * fresh price is requested before payment can continue.
 */
export function usePricing(input: PricingInput): { retry: () => void } {
  const { dispatch } = input;
  const savedRef = useRef<SavedRevision | null>(null);
  const quoteAttemptRef = useRef(0);
  const sessionId = input.sessionId;
  const file = input.file;
  const fileKey = file ? `${file.id}:${file.processingRevision}:${file.pageCount}` : null;
  const settingsKey = JSON.stringify(input.settings);
  const status = input.pricing.status;
  const debounce = input.debounceMilliseconds ?? DEFAULT_DEBOUNCE_MS;

  // What this run is pricing. A result is only ever applied while it still
  // describes what the customer is looking at; anything else is discarded
  // rather than shown as the price of a different configuration.
  const requestKey = `${sessionId ?? ""}|${fileKey ?? ""}|${settingsKey}`;
  const latest = useRef({
    settings: input.settings,
    sessionVersion: input.sessionVersion,
    file,
    requestKey
  });
  latest.current = {
    settings: input.settings,
    sessionVersion: input.sessionVersion,
    file,
    requestKey
  };

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!sessionId || !fileKey || status !== "IDLE") return;

    const timer = setTimeout(() => {
      void (async () => {
        const current = latest.current;
        const runKey = current.requestKey;
        const pricedFile = current.file;
        if (!pricedFile) return;
        const stale = () => !mounted.current || latest.current.requestKey !== runKey;
        dispatch({ type: "PRICING_PENDING" });

        try {
          const body = buildSettingsBody(pricedFile, current.settings);
          const fingerprint = `${fileKey}|${JSON.stringify(body)}`;
          let saved = savedRef.current;

          if (!saved || saved.fingerprint !== fingerprint) {
            const response = await saveKioskSettings(sessionId, current.sessionVersion, body);
            if (stale()) return;
            dispatch({ type: "SESSION_VERSION_OBSERVED", version: response.sessionVersion });
            saved = {
              fingerprint,
              revision: response.settings.revision,
              snapshot: response.settings
            };
            savedRef.current = saved;
          }

          quoteAttemptRef.current += 1;
          const quote = await createKioskQuote(sessionId, saved.revision, quoteAttemptRef.current);
          if (stale()) return;
          dispatch({ type: "PRICING_RESOLVED", settings: saved.snapshot, quote });
        } catch (error) {
          // The saved revision may be the reason this failed, so the next
          // attempt always re-saves rather than trusting a remembered one.
          savedRef.current = null;
          if (stale()) return;
          dispatch({
            type: "PRICING_FAILED",
            errorCode: error instanceof PricingRequestError ? error.code : "PRICING_UNAVAILABLE"
          });
        }
      })();
    }, debounce);

    return () => clearTimeout(timer);
  }, [debounce, dispatch, fileKey, sessionId, settingsKey, status]);

  const quote = input.pricing.quote;
  const expiresAt = quote?.expiresAt ?? null;
  useEffect(() => {
    if (status !== "READY" || !expiresAt) return;

    const expiry = new Date(expiresAt).getTime();
    if (Date.now() >= expiry) {
      dispatch({ type: "PRICING_CLEARED" });
      return;
    }

    // Polling rather than one long timer: a deadline further out than a signed
    // 32-bit millisecond count would make setTimeout fire immediately and throw
    // a perfectly good price away.
    const timer = setInterval(() => {
      if (Date.now() >= expiry) dispatch({ type: "PRICING_CLEARED" });
    }, EXPIRY_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [dispatch, expiresAt, status]);

  const retry = useCallback(() => {
    savedRef.current = null;
    dispatch({ type: "PRICING_CLEARED" });
  }, [dispatch]);

  return { retry };
}
