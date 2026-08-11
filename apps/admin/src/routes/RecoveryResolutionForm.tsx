import { useCallback, useState } from "react";

import {
  RECOVERY_OUTCOMES,
  suggestsRefund,
  type AdminRecoveryCorrection,
  type AdminRecoveryResolution,
  type RecoveryOutcome
} from "@printing-kiosk/admin-access";

import { observabilityApi } from "../features/observability/api.js";
import { When } from "../features/observability/components.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";

/**
 * Recording what a person saw at the tray.
 *
 * This is the only form in the control plane that writes about a paid print, so
 * it is written to make the honest answer the easy one. The four outcomes are
 * laid out as full sentences rather than as codes, `UNRESOLVABLE` is offered
 * with the same weight as the rest, and the consequence of each choice — money
 * looks owed, or it does not — is stated on screen before the operator commits.
 *
 * What the device reported is shown alongside, because the gap between that and
 * what a person counted is the reason this record exists.
 *
 * The form cannot pay anybody. It says so, in as many words, right where an
 * operator might otherwise assume that reporting a missing print refunds it.
 */

const OUTCOME_LABELS: Readonly<Record<RecoveryOutcome, { title: string; detail: string }>> = {
  DELIVERED: {
    title: "The customer got their pages",
    detail: "Everything they paid for came out and they took it."
  },
  PARTIALLY_DELIVERED: {
    title: "Some pages came out, not all",
    detail: "Part of the job printed. An Admin decides what, if anything, is owed."
  },
  NOT_DELIVERED: {
    title: "Nothing usable came out",
    detail: "The tray was empty, or what came out was unusable. Money looks owed."
  },
  UNRESOLVABLE: {
    title: "I cannot tell what happened",
    detail: "The customer had gone, or the kiosk was already cleared. Recorded as unknown."
  }
};

export function RecoveryResolutionForm({
  printJobId,
  deviceSheets,
  paidSheets,
  onRecorded
}: {
  printJobId: string;
  deviceSheets: number | null;
  paidSheets: number;
  onRecorded: () => void;
}) {
  const [outcome, setOutcome] = useState<RecoveryOutcome | "">("");
  const [reason, setReason] = useState("");
  const [sheets, setSheets] = useState("");

  const action = useAdminAction<{ outcome: RecoveryOutcome; reason: string; sheets: string }>(
    useCallback(
      async (input) =>
        observabilityApi.resolveRecovery(printJobId, {
          outcome: input.outcome,
          reason: input.reason.trim(),
          // A count is offered only where it can mean something. Sending an
          // empty one as zero would turn "I did not count" into "there were
          // none", which is a different claim about a print somebody paid for.
          ...(input.sheets === "" || input.outcome === "UNRESOLVABLE"
            ? {}
            : { observedSheets: Number(input.sheets) })
        }),
      [printJobId]
    )
  );

  const trimmed = reason.trim();
  const countable = outcome !== "" && outcome !== "UNRESOLVABLE" && outcome !== "NOT_DELIVERED";
  const ready = outcome !== "" && trimmed.length >= 8 && !action.state.running;

  return (
    <form
      className="resolve"
      onSubmit={(event) => {
        event.preventDefault();
        if (outcome === "" || !ready) return;
        void action.run({ outcome, reason, sheets }).then((recorded) => {
          if (recorded) onRecorded();
        });
      }}
    >
      <h3>What happened to this print?</h3>
      <p className="resolve__device">
        The printer reported{" "}
        <strong>{deviceSheets === null ? "no sheet count" : `${deviceSheets} sheet(s)`}</strong> for
        a job paid as {paidSheets}, and could not confirm it. Only a person can settle this.
      </p>

      <fieldset className="resolve__outcomes">
        <legend>What you saw</legend>
        {RECOVERY_OUTCOMES.map((value) => (
          <label
            key={value}
            className={outcome === value ? "resolve__option is-chosen" : "resolve__option"}
          >
            <input
              type="radio"
              name="outcome"
              value={value}
              checked={outcome === value}
              onChange={() => {
                setOutcome(value);
                if (value === "UNRESOLVABLE" || value === "NOT_DELIVERED") setSheets("");
              }}
            />
            <span>
              <strong>{OUTCOME_LABELS[value].title}</strong>
              <small>{OUTCOME_LABELS[value].detail}</small>
            </span>
          </label>
        ))}
      </fieldset>

      {countable ? (
        <label className="resolve__field">
          Sheets you counted <span className="resolve__optional">optional</span>
          <input
            type="number"
            min={1}
            max={10000}
            value={sheets}
            onChange={(event) => setSheets(event.target.value)}
            placeholder="Leave blank if you did not count"
          />
        </label>
      ) : null}

      <label className="resolve__field">
        What you saw, in your own words
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={280}
          placeholder="Tray was empty and the display showed a paper jam."
        />
        <small className="resolve__optional">
          {trimmed.length < 8
            ? "A few words at least — this may be the only record of the decision."
            : `${trimmed.length}/280`}
        </small>
      </label>

      {outcome !== "" && suggestsRefund(outcome) ? (
        <p className="resolve__money" role="note">
          This records that money looks owed. <strong>It does not refund anything.</strong> An
          administrator with refund authority decides that separately.
        </p>
      ) : null}

      {action.state.error ? (
        <p className="resolve__error" role="alert">
          {action.state.error}
        </p>
      ) : null}

      <div className="resolve__actions">
        <button type="submit" disabled={!ready}>
          {action.state.running ? "Recording…" : "Record what I saw"}
        </button>
        <span className="resolve__optional">
          Permanent and attributed to you. It cannot be edited afterwards.
        </span>
      </div>
    </form>
  );
}

/**
 * The stored account of a print: the original observation, then any correction.
 *
 * Both are shown, always. A correction that replaced what it corrected on
 * screen would be an edit wearing a different name, and the whole reason a
 * correction is a new row rather than an UPDATE is that the earlier version
 * stays readable by whoever looks next.
 */
export function RecordedResolution({
  resolution,
  corrections
}: {
  resolution: AdminRecoveryResolution;
  corrections: readonly AdminRecoveryCorrection[];
}) {
  const superseded = new Set(corrections.map((correction) => correction.supersedesId));
  const effective = corrections.at(-1) ?? resolution;

  return (
    <div className="resolution">
      <div className={superseded.has(resolution.id) ? "resolution__superseded" : ""}>
        <p className="resolution__outcome">
          <strong>{OUTCOME_LABELS[resolution.outcome].title}</strong>
          {resolution.observedSheets === null ? null : (
            <span className="key-list__meta">{resolution.observedSheets} sheet(s) counted</span>
          )}
        </p>
        <blockquote className="resolution__reason">{resolution.reason}</blockquote>
        <p className="resolution__by">
          {resolution.resolvedByDisplayName ?? "Unknown"} ({resolution.resolvedByRole}) &middot;{" "}
          <When value={resolution.resolvedAt} />
          {superseded.has(resolution.id) ? " · corrected below" : null}
        </p>
      </div>

      {corrections.map((correction) => (
        <div
          key={correction.id}
          className={
            superseded.has(correction.id)
              ? "resolution__correction resolution__superseded"
              : "resolution__correction"
          }
        >
          <p className="resolution__outcome">
            <span className="key-list__meta">Corrected to</span>{" "}
            <strong>{OUTCOME_LABELS[correction.outcome].title}</strong>
            {correction.observedSheets === null ? null : (
              <span className="key-list__meta">{correction.observedSheets} sheet(s) counted</span>
            )}
          </p>
          <blockquote className="resolution__reason">{correction.reason}</blockquote>
          <p className="resolution__by">
            {correction.correctedByDisplayName ?? "Unknown"} ({correction.correctedByRole}) &middot;{" "}
            <When value={correction.correctedAt} />
            {superseded.has(correction.id) ? " · corrected below" : null}
          </p>
        </div>
      ))}

      {effective.refundSuggested ? (
        <p className="resolve__money" role="note">
          Money looks owed on this print. Whether it is refunded is an administrator&apos;s decision
          and is recorded separately.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Putting right an account of a print that turned out to be wrong.
 *
 * Deliberately not a friendly edit form. The wording says what this actually
 * does — appends a correction that supersedes what somebody else recorded,
 * permanently and under your name — because an interface that made it feel like
 * editing a field would be an interface that encouraged rewriting evidence.
 *
 * `supersedesId` is the record on screen at the moment the form is opened. If
 * somebody else corrects it first, the server refuses this with a 409 rather
 * than quietly letting the second answer win.
 */
export function RecoveryCorrectionForm({
  printJobId,
  supersedesId,
  currentOutcome,
  onCorrected
}: {
  printJobId: string;
  supersedesId: string;
  currentOutcome: RecoveryOutcome;
  onCorrected: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<RecoveryOutcome | "">("");
  const [reason, setReason] = useState("");
  const [sheets, setSheets] = useState("");

  const action = useAdminAction<{ outcome: RecoveryOutcome; reason: string; sheets: string }>(
    useCallback(
      async (input) =>
        observabilityApi.correctRecovery(printJobId, {
          supersedesId,
          outcome: input.outcome,
          reason: input.reason.trim(),
          ...(input.sheets === "" || input.outcome === "UNRESOLVABLE"
            ? {}
            : { observedSheets: Number(input.sheets) })
        }),
      [printJobId, supersedesId]
    )
  );

  if (!open) {
    return (
      <p className="resolve__actions">
        <button type="button" className="button-quiet" onClick={() => setOpen(true)}>
          This account is wrong — correct it
        </button>
      </p>
    );
  }

  const trimmed = reason.trim();
  const countable = outcome !== "" && outcome !== "UNRESOLVABLE" && outcome !== "NOT_DELIVERED";
  const ready =
    outcome !== "" && outcome !== currentOutcome && trimmed.length >= 8 && !action.state.running;

  return (
    <form
      className="resolve"
      onSubmit={(event) => {
        event.preventDefault();
        if (outcome === "" || !ready) return;
        void action.run({ outcome, reason, sheets }).then((recorded) => {
          if (recorded) {
            setOpen(false);
            onCorrected();
          }
        });
      }}
    >
      <h3>Correct this record</h3>
      <p className="resolve__device">
        The record above stays exactly as written. This adds a later account that supersedes it,
        under your name. Say what was actually the case and why the earlier account was wrong.
      </p>

      <fieldset className="resolve__outcomes">
        <legend>What was actually the case</legend>
        {RECOVERY_OUTCOMES.map((value) => (
          <label
            key={value}
            className={outcome === value ? "resolve__option is-chosen" : "resolve__option"}
          >
            <input
              type="radio"
              name="correction-outcome"
              value={value}
              checked={outcome === value}
              disabled={value === currentOutcome}
              onChange={() => {
                setOutcome(value);
                if (value === "UNRESOLVABLE" || value === "NOT_DELIVERED") setSheets("");
              }}
            />
            <span>
              <strong>{OUTCOME_LABELS[value].title}</strong>
              <small>
                {value === currentOutcome
                  ? "This is what the record already says."
                  : OUTCOME_LABELS[value].detail}
              </small>
            </span>
          </label>
        ))}
      </fieldset>

      {countable ? (
        <label className="resolve__field">
          Sheets actually delivered <span className="resolve__optional">optional</span>
          <input
            type="number"
            min={1}
            max={10000}
            value={sheets}
            onChange={(event) => setSheets(event.target.value)}
            placeholder="Leave blank if nobody counted"
          />
        </label>
      ) : null}

      <label className="resolve__field">
        Why the earlier account was wrong
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={280}
          placeholder="The customer returned with the pages; they had been left in the lower tray."
        />
        <small className="resolve__optional">
          {trimmed.length < 8
            ? "A few words at least — this is the reason the record changed."
            : `${trimmed.length}/280`}
        </small>
      </label>

      {action.state.error ? (
        <p className="resolve__error" role="alert">
          {action.state.error}
        </p>
      ) : null}

      <div className="resolve__actions">
        <button type="submit" disabled={!ready}>
          {action.state.running ? "Recording…" : "Record the correction"}
        </button>
        <button type="button" className="button-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <span className="resolve__optional">
          It does not withdraw a refund anybody has already authorized.
        </span>
      </div>
    </form>
  );
}
