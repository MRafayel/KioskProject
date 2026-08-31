import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "./generated/prisma/client.js";
import { applyPrintJobSettlement } from "./print-jobs.js";

const now = new Date("2030-01-01T00:00:00.000Z");
const kioskId = "kiosk-001";
const printJobId = "01900000-0000-7000-8000-000000000111";

describe("software paper inventory", () => {
  it("does not create a paper deduction for a failed settlement", async () => {
    const paperUpdate = vi.fn();
    const paperLock = vi.fn().mockResolvedValue([{ estimated_sheets: 500 }]);
    const transaction = {
      printJob: {
        findUnique: vi.fn().mockResolvedValue({
          id: printJobId,
          kioskId,
          sessionId: "01900000-0000-7000-8000-000000000121",
          paymentId: "01900000-0000-7000-8000-000000000122",
          status: "PRINTING"
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      agentCommand: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      printJobEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({})
      },
      kioskPaperInventory: { update: paperUpdate },
      $queryRaw: paperLock,
      printSession: { findUnique: vi.fn().mockResolvedValue(null) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) }
    } as unknown as Prisma.TransactionClient;

    await applyPrintJobSettlement(transaction, {
      printJobId,
      status: "FAILED",
      resultConfidence: "CONFIRMED",
      failureCode: "PRINT_FAILED",
      warningCode: null,
      sheetsProduced: 0,
      sessionState: "FAILED",
      refundObligation: false,
      operationId: null,
      ledgerType: "FAILED",
      actorType: "KIOSK_AGENT",
      actorId: "agent-001",
      now,
      newId: () => "01900000-0000-7000-8000-000000000123",
      retentionPolicy: { settledGraceMilliseconds: 0, recoveryGraceMilliseconds: 0 }
    });

    // Not even a read: a failed print consumed nothing to deduct.
    expect(paperLock).not.toHaveBeenCalled();
    expect(paperUpdate).not.toHaveBeenCalled();
  });
});
