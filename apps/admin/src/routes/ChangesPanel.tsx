import { useCallback, useState } from "react";

import type { ChangePreview, PricingPublishPayload } from "@printing-kiosk/admin-access";

import { observabilityApi } from "../features/observability/api.js";
import {
  Empty,
  Money,
  RowWhen,
  StateBadge,
  Table,
  When
} from "../features/observability/components.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";
import { useAdminData } from "../features/observability/useAdminData.js";
import { useSession } from "../features/auth/SessionProvider.js";

/**
 * Changing the prices.
 *
 * Deliberately plain: the panels in this build are temporary, so this one does
 * the minimum that lets an Admin operate and verify the workflow — see the
 * current pricing, preview a change, publish it, and read what was published
 * before.
 *
 * Two behaviours here are load-bearing rather than cosmetic, and should survive
 * whatever replaces this file:
 *
 *   - **Publishing is unavailable until the change has been priced out.** The
 *     digests the publish call must echo come from the preview, so a screen that
 *     let somebody skip it would be offering to publish numbers nobody
 *     multiplied out.
 *   - **Editing the form clears the preview.** The digest covers exactly the
 *     numbers that were priced, so a stale preview beside an edited form is the
 *     one state that must not be publishable. The server refuses it as well —
 *     this only keeps the screen from offering something it will be told no for.
 *
 * It does not poll. An Admin part-way through reading a set of numbers must not
 * have them replaced underneath them.
 */

interface FormState {
  version: string;
  unitAmountMinor: string;
  serviceFeeMinor: string;
  minimumAmountMinor: string;
  taxBasisPoints: string;
  duplexAdjustmentBasisPoints: string;
}

const NUMERIC_FIELDS = [
  ["unitAmountMinor", "Per printed side (minor units)"],
  ["serviceFeeMinor", "Service fee (minor units)"],
  ["minimumAmountMinor", "Minimum charge (minor units)"],
  ["taxBasisPoints", "Tax (basis points)"],
  ["duplexAdjustmentBasisPoints", "Duplex adjustment (basis points)"]
] as const;

const EMPTY_FORM: FormState = {
  version: "",
  unitAmountMinor: "",
  serviceFeeMinor: "",
  minimumAmountMinor: "",
  taxBasisPoints: "",
  duplexAdjustmentBasisPoints: ""
};

export function ChangesPanel() {
  const session = useSession();
  const load = useCallback(() => observabilityApi.changes(), []);
  const state = useAdminData(load);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [published, setPublished] = useState<string | null>(null);

  const mayPublish = session.can("pricing.publish");

  /** Any edit invalidates the preview: its digest was over the old numbers. */
  const edit = useCallback((field: keyof FormState, value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setPreview(null);
    setPublished(null);
  }, []);

  const previewAction = useAdminAction(async (input: PricingPublishPayload) => {
    const result = await observabilityApi.previewChange({
      payload: { kind: "PRICING_PUBLISH", pricing: input }
    });
    setPreview(result.preview);
  });

  const publishAction = useAdminAction(
    async (input: { payload: PricingPublishPayload; preview: ChangePreview }) => {
      const result = await observabilityApi.publishChange({
        payload: { kind: "PRICING_PUBLISH", pricing: input.payload },
        payloadDigest: input.preview.payloadDigest,
        baselineDigest: input.preview.baselineDigest,
        reason
      });
      setPublished(result.publishedVersion);
      setPreview(null);
      setForm(EMPTY_FORM);
      setReason("");
      state.reload();
    }
  );

  if (!state.data) return null;
  const { changes, current } = state.data;
  const payload = toPayload(form);

  return (
    <>
      <section className="panel">
        <header className="panel__header">
          <h2>Current pricing</h2>
          <button type="button" onClick={state.reload} disabled={state.loading}>
            Refresh
          </button>
        </header>

        {current ? (
          <p className="panel__hint">
            Current version <strong>{current.version}</strong>:{" "}
            <Money
              minor={current.unitAmountMinor}
              currency={current.currency}
              exponent={current.currencyExponent}
            />{" "}
            per printed side,{" "}
            <Money
              minor={current.serviceFeeMinor}
              currency={current.currency}
              exponent={current.currencyExponent}
            />{" "}
            service fee,{" "}
            <Money
              minor={current.minimumAmountMinor}
              currency={current.currency}
              exponent={current.currencyExponent}
            />{" "}
            minimum charge, tax {current.taxBasisPoints} basis points, duplex adjustment{" "}
            {current.duplexAdjustmentBasisPoints} basis points. Published{" "}
            <When value={current.publishedAt} />.
          </p>
        ) : (
          <Empty>No pricing has been published, so there is nothing to replace.</Empty>
        )}

        {published ? (
          <p className="panel__status" role="status">
            Published pricing version {published}. Every kiosk is using it now.
          </p>
        ) : null}

        {mayPublish && current ? (
          <form
            className="change-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (payload) void previewAction.run(payload);
            }}
          >
            <p className="panel__hint">
              Publishing updates every kiosk immediately and archives the current version. Enter
              every proposed value, including values that are not changing, then preview the prices
              before publishing.
            </p>

            <label>
              Version name
              <input
                value={form.version}
                onChange={(event) => edit("version", event.target.value)}
                placeholder={`${current.version}-next`}
              />
            </label>

            {/* Five integers that are read together and compared against what
                is in force, so they are laid out as a grid rather than as five
                stacked lines a person has to scroll between. */}
            <div className="change-form__numbers">
              {NUMERIC_FIELDS.map(([field, label]) => (
                <label key={field}>
                  {label}
                  <input
                    inputMode="numeric"
                    value={form[field]}
                    onChange={(event) => edit(field, event.target.value)}
                  />
                </label>
              ))}
            </div>

            <button type="submit" disabled={!payload || previewAction.state.running}>
              {previewAction.state.running ? "Previewing…" : "Preview prices"}
            </button>
            {previewAction.state.error ? (
              <p className="panel__status" role="alert">
                {previewAction.state.error}
              </p>
            ) : null}
          </form>
        ) : null}

        {preview ? (
          <div className="reveal">
            <Table
              caption="Preview for common print jobs"
              columns={["Job", "Now", "After", "Change"]}
            >
              {preview.rows.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td>
                    {row.currentTotalMinor === null ? (
                      "—"
                    ) : (
                      <Money
                        minor={row.currentTotalMinor}
                        currency={preview.currency}
                        exponent={preview.currencyExponent}
                      />
                    )}
                  </td>
                  <td>
                    <Money
                      minor={row.proposedTotalMinor}
                      currency={preview.currency}
                      exponent={preview.currencyExponent}
                    />
                  </td>
                  <td>
                    <Money
                      minor={row.differenceMinor}
                      currency={preview.currency}
                      exponent={preview.currencyExponent}
                    />
                  </td>
                </tr>
              ))}
            </Table>

            <label className="change-form__reason">
              Why these prices are changing
              <textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>

            <button
              type="button"
              className="button-primary"
              disabled={!payload || reason.trim().length < 8 || publishAction.state.running}
              onClick={() => {
                if (payload) void publishAction.run({ payload, preview });
              }}
            >
              {publishAction.state.running ? "Publishing…" : "Publish to every kiosk now"}
            </button>
            {publishAction.state.error ? (
              <p className="panel__status" role="alert">
                {publishAction.state.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>Pricing history</h2>
        </header>

        {changes.length === 0 ? (
          <Empty>No pricing changes have been published here yet.</Empty>
        ) : (
          <Table
            className="data-table"
            pane
            paneClassName="data-pane"
            columns={["Version", "Replaced", "Published", "By", "Why", ""]}
          >
            {changes.map((change) => (
              <tr key={change.id}>
                <td data-label="Version">
                  <strong>{change.resultRef}</strong>
                </td>
                <td data-label="Replaced">{change.replacedRef ?? "—"}</td>
                <td data-label="Published">
                  <RowWhen value={change.publishedAt} />
                </td>
                <td data-label="By">
                  {change.publishedByDisplayName ?? change.publishedByAdminUserId}
                </td>
                <td data-label="Why">{change.reason}</td>
                <td data-label="">
                  {change.inForce ? <StateBadge value="Current" tone="good" /> : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </>
  );
}

/** The form as numbers, or null while it is not yet a complete pricing version. */
function toPayload(form: FormState): PricingPublishPayload | null {
  if (form.version.trim().length < 3) return null;
  if (NUMERIC_FIELDS.some(([field]) => form[field].trim() === "")) return null;

  const numbers = {
    unitAmountMinor: Number(form.unitAmountMinor),
    serviceFeeMinor: Number(form.serviceFeeMinor),
    minimumAmountMinor: Number(form.minimumAmountMinor),
    taxBasisPoints: Number(form.taxBasisPoints),
    duplexAdjustmentBasisPoints: Number(form.duplexAdjustmentBasisPoints)
  };
  if (!Object.values(numbers).every((value) => Number.isInteger(value))) return null;

  return { version: form.version.trim(), ...numbers };
}
