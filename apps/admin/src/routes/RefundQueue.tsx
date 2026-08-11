import { useCallback, useState } from "react";

import { suggestedRefundMinor, type AdminRefundQueueEntry } from "@printing-kiosk/admin-access";

import { observabilityApi } from "../features/observability/api.js";
import { Empty, Identifier, Money, When } from "../features/observability/components.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * The prints waiting for somebody who can decide about money.
 *
 * Two things are true at once here and the screen has to hold both. This is a
 * worklist — a customer is out of pocket until somebody acts on it — and it is
 * the one place in the control plane where a click costs real money. So the
 * rows are ordered oldest first and stated plainly, and the act of authorizing
 * is a deliberate two-step with the numbers spelled out.
 *
 * What an Admin is deciding *from* is an operator's account of what came out of
 * a printer, and that account is shown in the operator's own words rather than
 * summarised into a status. If it has been corrected, the corrected version is
 * what appears, marked as corrected, because paying out against superseded
 * evidence is exactly the mistake the correction existed to prevent.
 */

const QUEUE_REASON_LABELS = {
  REFUND_SUGGESTED: {
    title: "A person says pages are missing",
    detail: "The question is how much is owed."
  },
  UNRESOLVABLE: {
    title: "Nobody could tell what happened",
    detail: "No refund is suggested. This is a judgement call, which is why it is here."
  }
} as const;

export function RefundQueue({
  canAuthorize,
  onAuthorized
}: {
  canAuthorize: boolean;
  onAuthorized: () => void;
}) {
  // No polling, deliberately. Every other panel refreshes on a timer; an Admin
  // part-way through typing an amount must not have the row underneath them
  // replaced, and a money screen that moves on its own is one somebody
  // misclicks.
  const load = useCallback(() => observabilityApi.refundQueue(), []);
  const state = useAdminData(load);

  if (!state.data) return null;

  const { items, totals } = state.data;

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Waiting on a money decision</h2>
        <button type="button" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
      </header>

      {items.length === 0 ? (
        <Empty>
          No print is waiting for a refund decision. Prints leave this list when a refund is
          authorized, or when somebody corrects the record to say the customer got their pages.
        </Empty>
      ) : (
        <>
          <p className="panel__status">
            {totals.suggested} where a person says pages are missing, {totals.unresolvable} where
            nobody could tell. Oldest first.
          </p>
          <ul className="refund-queue">
            {items.map((entry) => (
              <RefundQueueRow
                key={entry.printJobId}
                entry={entry}
                canAuthorize={canAuthorize}
                onAuthorized={() => {
                  state.reload();
                  onAuthorized();
                }}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RefundQueueRow({
  entry,
  canAuthorize,
  onAuthorized
}: {
  entry: AdminRefundQueueEntry;
  canAuthorize: boolean;
  onAuthorized: () => void;
}) {
  const [open, setOpen] = useState(false);
  const label = QUEUE_REASON_LABELS[entry.queueReason];

  return (
    <li className="refund-queue__item">
      <div className="refund-queue__account">
        <p className="resolution__outcome">
          <strong>{label.title}</strong>
          {entry.corrected ? <span className="key-list__meta">corrected</span> : null}
        </p>
        <blockquote className="resolution__reason">{entry.reason}</blockquote>
        <p className="resolution__by">
          {entry.observedByDisplayName ?? "Unknown"} &middot; <When value={entry.observedAt} />{" "}
          &middot; {entry.kioskId} &middot; <Identifier value={entry.printJobId} />
        </p>
        <p className="resolution__by">
          Paid for {entry.physicalSheets} sheet(s); the printer reported{" "}
          {entry.sheetsProduced === null ? "no count" : `${entry.sheetsProduced}`}, a person counted{" "}
          {entry.observedSheets === null ? "none" : entry.observedSheets}. {label.detail}
        </p>
      </div>

      <div className="refund-queue__money">
        <p>
          Captured{" "}
          <Money
            minor={entry.capturedAmountMinor}
            currency={entry.currency}
            exponent={entry.currencyExponent}
          />
          {entry.refundedAmountMinor > 0 ? (
            <>
              {" "}
              &middot; already owed{" "}
              <Money
                minor={entry.refundedAmountMinor}
                currency={entry.currency}
                exponent={entry.currencyExponent}
              />
            </>
          ) : null}
        </p>
        <p className="key-list__meta">
          At most{" "}
          <Money
            minor={entry.authorizableAmountMinor}
            currency={entry.currency}
            exponent={entry.currencyExponent}
          />{" "}
          may still be authorized.
        </p>

        {canAuthorize && entry.authorizableAmountMinor > 0 && !open ? (
          <button type="button" onClick={() => setOpen(true)}>
            Authorize a refund
          </button>
        ) : null}
        {!canAuthorize ? (
          <p className="key-list__meta">
            Authorizing a refund is a capability your role does not hold.
          </p>
        ) : null}
        {entry.authorizableAmountMinor === 0 ? (
          <p className="key-list__meta">
            Everything captured on this payment is already owed back.
          </p>
        ) : null}
      </div>

      {open ? (
        <RefundAuthorizationForm
          entry={entry}
          onCancel={() => setOpen(false)}
          onAuthorized={() => {
            setOpen(false);
            onAuthorized();
          }}
        />
      ) : null}
    </li>
  );
}

/**
 * Authorizing a payout.
 *
 * The amount is prefilled with what the observation implies and is editable,
 * because the arithmetic cannot know that the customer reprinted two of the
 * ruined sheets themselves — but an amount nobody could change would be an
 * amount nobody took responsibility for either.
 *
 * The form says what it does and what it does not. It creates an obligation to
 * pay; it does not pay. Somebody reading this screen should not be able to come
 * away believing the customer has their money back.
 */
function RefundAuthorizationForm({
  entry,
  onCancel,
  onAuthorized
}: {
  entry: AdminRefundQueueEntry;
  onCancel: () => void;
  onAuthorized: () => void;
}) {
  const suggested = suggestedRefundMinor(entry);
  const [amount, setAmount] = useState(String(suggested ?? ""));
  const [reason, setReason] = useState("");

  const action = useAdminAction<{ amountMinor: number; reason: string }>(
    useCallback(
      async (input) =>
        observabilityApi.authorizeRefund(entry.printJobId, {
          amountMinor: input.amountMinor,
          reason: input.reason.trim()
        }),
      [entry.printJobId]
    )
  );

  const parsed = Number(amount);
  const amountValid =
    Number.isInteger(parsed) && parsed > 0 && parsed <= entry.authorizableAmountMinor;
  const trimmed = reason.trim();
  const ready = amountValid && trimmed.length >= 8 && !action.state.running;

  return (
    <form
      className="resolve"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void action.run({ amountMinor: parsed, reason }).then((recorded) => {
          if (recorded) onAuthorized();
        });
      }}
    >
      <h3>Authorize a refund</h3>

      <label className="resolve__field">
        Amount, in minor units of {entry.currency}
        <input
          type="number"
          min={1}
          max={entry.authorizableAmountMinor}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <small className="resolve__optional">
          {suggested === null
            ? `Up to ${entry.authorizableAmountMinor}. Nothing here suggests an amount — that is what makes this a decision.`
            : `Suggested ${suggested} from what was observed. Up to ${entry.authorizableAmountMinor}.`}
        </small>
      </label>

      <label className="resolve__field">
        Why this amount
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={280}
          placeholder="Four of the ten sheets were unusable; refunding those four."
        />
        <small className="resolve__optional">
          {trimmed.length < 8
            ? "A few words at least — this is the record of why a customer was paid."
            : `${trimmed.length}/280`}
        </small>
      </label>

      <p className="resolve__money" role="note">
        This records an obligation to return money. <strong>It does not pay anybody.</strong> The
        refund is settled against the payment provider separately, and it cannot be withdrawn from
        this panel afterwards.
      </p>

      {action.state.error ? (
        <p className="resolve__error" role="alert">
          {action.state.error}
        </p>
      ) : null}

      <div className="resolve__actions">
        <button type="submit" disabled={!ready}>
          {action.state.running ? "Recording…" : "Authorize this refund"}
        </button>
        <button type="button" className="button-quiet" onClick={onCancel}>
          Cancel
        </button>
        <span className="resolve__optional">Permanent and attributed to you.</span>
      </div>
    </form>
  );
}
