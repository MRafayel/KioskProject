# Phase 1 status

- Date: 2026-07-13
- Status: complete

## Implemented

- Print-only welcome screen with Print as the only service.
- Real prototype QR code and short session code.
- Deterministic simulated phone upload for a PDF document.
- Uploaded-file confirmation and removal path.
- Monochrome settings for page range, paper size, orientation, pages per side,
  simplex/duplex, and 1–10 copies.
- Pure sheet, side, and prototype-price calculation outside React screens.
- Checkout and simulated payment progress.
- Simulated successful printing, payment decline, and printer failure.
- Retry paths for payment and printing failures.
- Success screen with explicit file-deletion completion action.
- Session cancellation confirmation on pre-payment screens, with cancellation
  hidden once payment begins so the kiosk never promises that no charge was
  made after payment.
- Sixty-second inactivity warning and ninety-second privacy reset.
- Error boundary with a safe kiosk restart screen.
- Large touch controls, visible keyboard focus, reduced-motion support, and
  responsive landscape layouts.

## Architecture

- Route screens live under `apps/kiosk/src/routes`.
- Reusable kiosk chrome and idle behavior live under
  `apps/kiosk/src/components`.
- Prototype session state, transition actions, settings, and price math live
  under `apps/kiosk/src/features/session`.
- Backend-free Phase 1 behavior lives under `apps/kiosk/src/mocks` and will be
  replaced by the authoritative Phase 2 API without moving business state into
  UI components.
- Runtime and development dependencies are version-pinned. MSW's optional
  install script is explicitly denied rather than added to the approved build
  allowlist.

## Verified

- Five Vitest/Testing Library tests cover state reset, price/sheet math, the
  upload-to-checkout journey, cancellation, and fake-timer idle reset.
- Six Playwright tests pass in pinned Chromium across 1280×800 and 1920×1080.
- Browser coverage includes the happy path, browser Back, cancellation,
  printer failure, retry, keyboard focus, and automated axe checks.
- Axe reports no serious or critical accessibility violations on the welcome
  and upload screens.
- A 1280×800 Chromium render was visually inspected for hierarchy, readability,
  touch sizing, clipping, and kiosk-frame fit.
- Strict TypeScript, ESLint, Prettier, and production builds pass for the kiosk
  package.

Phase 2 may now replace prototype session creation with authoritative backend
sessions while keeping the established touchscreen journey and print-only
monochrome boundary.
