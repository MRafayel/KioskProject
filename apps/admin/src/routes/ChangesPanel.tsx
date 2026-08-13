import { useCallback, useState } from "react";

import type { ChangePreview, PricingPublishPayload } from "@printing-kiosk/admin-access";

import { observabilityApi } from "../features/observability/api.js";
import { Empty, Money, StateBadge, Table, When } from "../features/observability/components.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";
import { useAdminData } from "../features/observability/useAdminData.js";
import { useSession } from "../features/auth/SessionProvider.js";

/**
 * Changing the prices.
 *
 * Deliberately plain: the panels in this build are temporary, so this one does
 * the minimum that lets an Admin operate and verify the workflow — see the
 * tariff in force, price a change out, publish it, and read what was published
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
  ["unitAmountMinor", "Per printed side"],
  ["serviceFeeMinor", "Service fee"],
  ["minimumAmountMinor", "Minimum charge"],
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
          <h2>Prices</h2>
          <button type="button" onClick={state.reload} disabled={state.loading}>
            Refresh
          </button>
        </header>

        {current ? (
          <p className="panel__hint">
            In force: <strong>{current.version}</strong> —{" "}
            <Money
              minor={current.unitAmountMinor}
              currency={current.currency}
              exponent={current.currencyExponent}
            />{" "}
            per side, fee{" "}
            <Money
              minor={current.serviceFeeMinor}
              currency={current.currency}
              exponent={current.currencyExponent}
            />
            , minimum{" "}
            <Money
              minor={current.minimumAmountMinor}
              currency={current.currency}
              exponent={current.currencyExponent}
            />
            , tax {current.taxBasisPoints} bp, duplex {current.duplexAdjustmentBasisPoints} bp.
            Published <When value={current.publishedAt} />.
          </p>
        ) : (
          <Empty>No tariff is published, so there is nothing to replace.</Empty>
        )}

        {published ? (
          <p className="panel__status" role="status">
            Published {published}. Every kiosk is quoting it now.
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
              Publishing takes effect at every kiosk the moment it commits, and the tariff it
              replaces is archived in the same transaction. Price the change out first: what you
              publish is what you were shown.
            </p>

            <label>
              Version name
              <input
                value={form.version}
                onChange={(event) => edit("version", event.target.value)}
                placeholder={`${current.version}-next`}
              />
            </label>

            {NUMERIC_FIELDS.map(([field, label]) => (
              <label key={field}>
                {label}
                <input
                  inputMode="numeric"
                  value={form[field]}
                  onChange={(event) => edit(field, event.target.value)}
                  placeholder={String(current[field])}
                />
              </label>
            ))}

            <button type="submit" disabled={!payload || previewAction.state.running}>
              {previewAction.state.running ? "Pricing…" : "Price this out"}
            </button>
            {previewAction.state.error ? (
              <p className="panel__status" role="alert">
                {previewAction.state.error}
              </p>
            ) : null}
          </form>
        ) : null}

        {preview ? (
          <>
            <Table
              caption="What these prices would charge"
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

            <label>
              Why these prices are changing
              <textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>

            <button
              type="button"
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
          </>
        ) : null}
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>What has been published</h2>
        </header>

        {changes.length === 0 ? (
          <Empty>Nothing has been published from here yet.</Empty>
        ) : (
          <Table columns={["Version", "Replaced", "Published", "By", "Why", ""]}>
            {changes.map((change) => (
              <tr key={change.id}>
                <td>{change.resultRef}</td>
                <td>{change.replacedRef ?? "—"}</td>
                <td>
                  <When value={change.publishedAt} />
                </td>
                <td>{change.publishedByDisplayName ?? change.publishedByAdminUserId}</td>
                <td>{change.reason}</td>
                <td>{change.inForce ? <StateBadge value="In force" tone="good" /> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </>
  );
}

/** The form as numbers, or null while it is not yet a complete tariff. */
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
