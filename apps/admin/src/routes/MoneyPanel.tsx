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

/**
 * Payments, and the money owed back.
 *
 * Both are reads. Nothing on this page settles an obligation: that is
 * `refund.authorize`, a capability held by different people, and it does not
 * exist as an endpoint yet. Seeing that money is owed and deciding to pay it
 * are deliberately not the same permission.
 */
export function MoneyPanel() {
  const session = useSession();
  const canSeeRefunds = session.can("refund.obligation.read");
  const canReconcile = session.can("payment.reconcile.read");

  const loadPayments = useCallback(() => observabilityApi.payments(), []);
  const payments = useAdminData(loadPayments, { refreshMilliseconds: 30_000 });

  const loadRefunds = useCallback(() => observabilityApi.refunds(true), []);
  const refunds = useAdminData(loadRefunds, {
    refreshMilliseconds: 30_000,
    enabled: canSeeRefunds
  });

  return (
    <>
      <Panel
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

      {canSeeRefunds ? (
        <Panel
          title="Refunds owed"
          state={refunds}
          hint="Obligations that have not been settled. Settling one is a separate capability and is not available here."
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
      ) : null}
    </>
  );
}
