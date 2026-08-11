import { useCallback } from "react";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  Empty,
  Identifier,
  Money,
  Panel,
  StateBadge,
  Table,
  When
} from "../features/observability/components.js";
import { useAdminData } from "../features/observability/useAdminData.js";
import { RefundQueue } from "./RefundQueue.js";

/**
 * Payments, the money owed back, and the prints still waiting for a decision.
 *
 * The queue leads, because it is the only thing on this page anybody has to
 * act on: the two tables below it are records of what already happened.
 *
 * One action lives here and it is the only one in the control plane that costs
 * money. Authorizing a refund creates an obligation; nothing on this page
 * settles one. Settling is done against the payment provider by something that
 * holds a provider credential, and no part of the panel does.
 */
export function MoneyPanel({ focus }: { focus?: "refunds" | undefined } = {}) {
  const session = useSession();
  const canSeeRefunds = session.can("refund.obligation.read");
  const canAuthorizeRefunds = session.can("refund.authorize");
  const canReconcile = session.can("payment.reconcile.read");

  const loadPayments = useCallback(() => observabilityApi.payments(), []);
  const payments = useAdminData(loadPayments, { refreshMilliseconds: 30_000 });

  const loadRefunds = useCallback(() => observabilityApi.refunds(true), []);
  const refunds = useAdminData(loadRefunds, {
    refreshMilliseconds: 30_000,
    enabled: canSeeRefunds
  });

  const paymentsPanel = (
    <Panel
      key="payments"
      title="Payments"
      state={payments}
      hint={
        canReconcile
          ? "Provider references are shown because your role reconciles against the provider's ledger."
          : "Provider references are withheld from your role."
      }
      actions={
        <button type="button" onClick={payments.reload} disabled={payments.loading}>
          Refresh
        </button>
      }
    >
      {payments.data && payments.data.items.length === 0 ? <Empty>No payments yet.</Empty> : null}

      {payments.data && payments.data.items.length > 0 ? (
        <Table
          columns={[
            "Payment",
            "Kiosk",
            "Amount",
            "Status",
            "Applied",
            "Attempts",
            ...(canReconcile ? ["Provider reference"] : []),
            "Created"
          ]}
        >
          {payments.data.items.map((payment) => (
            <tr key={payment.id}>
              <td>
                <Identifier value={payment.id} />
              </td>
              <td>{payment.kioskId}</td>
              <td>
                <Money
                  minor={payment.amountMinor}
                  currency={payment.currency}
                  exponent={payment.currencyExponent}
                />
              </td>
              <td>
                <StateBadge value={payment.status} />
                {payment.failureCode ? (
                  <span className="key-list__meta">{payment.failureCode}</span>
                ) : null}
              </td>
              <td>{payment.appliedToSession ? "yes" : "no"}</td>
              <td>{payment.attempts}</td>
              {canReconcile ? (
                <td>
                  <code>{payment.providerIntentId ?? "—"}</code>
                </td>
              ) : null}
              <td>
                <When value={payment.createdAt} />
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
    </Panel>
  );

  const refundsPanel = canSeeRefunds ? (
    <Panel
      key="refunds"
      title="Refunds owed"
      state={refunds}
      hint="Obligations that have not been settled. Authorizing one is done from the queue above; settling one is done against the payment provider and is not available here."
      actions={
        <button type="button" onClick={refunds.reload} disabled={refunds.loading}>
          Refresh
        </button>
      }
    >
      {refunds.data && refunds.data.items.length === 0 ? (
        <Empty>Nothing is owed back.</Empty>
      ) : null}

      {refunds.data && refunds.data.items.length > 0 ? (
        <Table
          columns={[
            "Refund",
            "Session",
            "Amount",
            "Reason",
            "Authorized by",
            "Status",
            "Outstanding",
            "Created"
          ]}
        >
          {refunds.data.items.map((refund) => (
            <tr key={refund.id}>
              <td>
                <Identifier value={refund.id} />
              </td>
              <td>
                <Identifier value={refund.sessionId} />
              </td>
              <td>
                <Money
                  minor={refund.amountMinor}
                  currency={refund.currency}
                  exponent={refund.currencyExponent}
                />
              </td>
              <td>
                <StateBadge value={refund.reason} />
              </td>
              <td>
                {/* Null means the payment path raised this on its own. "The
                    system noticed" and "a named person decided" are different
                    claims on the same ledger and should not look alike. */}
                {refund.authorizedByDisplayName ?? <span className="key-list__meta">system</span>}
                {refund.authorizationReason ? (
                  <span className="key-list__meta">{refund.authorizationReason}</span>
                ) : null}
              </td>
              <td>
                <StateBadge value={refund.status} />
              </td>
              <td>{refund.outstandingHours === null ? "—" : `${refund.outstandingHours} h`}</td>
              <td>
                <When value={refund.createdAt} />
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
    </Panel>
  ) : null;

  const queue = canSeeRefunds ? (
    <RefundQueue
      key="queue"
      canAuthorize={canAuthorizeRefunds}
      onAuthorized={() => {
        refunds.reload();
        payments.reload();
      }}
    />
  ) : null;

  // Arriving from "unsettled refunds" on the overview puts the money owed at
  // the top. Landing on the payment ledger and having to scroll past it to find
  // what you clicked is how a link stops being worth following.
  return (
    <>
      {queue}
      {focus === "refunds" ? refundsPanel : null}
      {paymentsPanel}
      {focus === "refunds" ? null : refundsPanel}
    </>
  );
}
