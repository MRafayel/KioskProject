import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "./generated/prisma/client.js";
import { applyPrintJobSettlement, recordConfirmedPaperConsumption } from "./print-jobs.js";

const now = new Date("2030-01-01T00:00:00.000Z");
const kioskId = "kiosk-001";
const printJobId = "01900000-0000-7000-8000-000000000111";

describe("software paper inventory", () => {
  it("deducts the confirmed physical-sheet count from an initialized estimate", async () => {
    const create = vi.fn().mockResolvedValue({ deltaSheets: -2, estimateAffected: true });
    const aggregate = vi
      .fn()
      .mockResolvedValueOnce({ _sum: { deltaSheets: 500 } })
      .mockResolvedValueOnce({ _sum: { deltaSheets: 498 } });
    const transaction = {
      kioskPaperEvent: {
        findFirst: vi.fn().mockResolvedValue({ id: "refill" }),
        aggregate,
        create
      }
    } as unknown as Prisma.TransactionClient;

    const result = await recordConfirmedPaperConsumption(transaction, {
      id: "01900000-0000-7000-8000-000000000112",
      kioskId,
      printJobId,
      // Four printed sides in duplex were already resolved by the agent to two
      // physical sheets. Inventory consumes this value, not document pages.
      sheetsProduced: 2,
      actorId: "agent-001",
      now
    });

    const inserted = create.mock.calls[0]?.[0] as {
      data: {
        type: string;
        quantitySheets: number;
        deltaSheets: number;
        printJobId: string;
      };
    };
    expect(inserted.data).toMatchObject({
      type: "PRINT_DEDUCTION",
      quantitySheets: 2,
      deltaSheets: -2,
      printJobId
    });
    expect(result).toEqual({
      consumedSheets: 2,
      estimateDeltaSheets: -2,
      estimateAffected: true,
      estimatedSheets: 498
    });
  });

  it("records confirmed output without inventing a balance before tracking starts", async () => {
    const create = vi.fn().mockResolvedValue({ deltaSheets: 0, estimateAffected: false });
    const aggregate = vi.fn();
    const transaction = {
      kioskPaperEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        aggregate,
        create
      }
    } as unknown as Prisma.TransactionClient;

    const result = await recordConfirmedPaperConsumption(transaction, {
      id: "01900000-0000-7000-8000-000000000113",
      kioskId,
      printJobId,
      sheetsProduced: 3,
      actorId: "agent-001",
      now
    });

    const inserted = create.mock.calls[0]?.[0] as {
      data: { quantitySheets: number; deltaSheets: number; estimateAffected: boolean };
    };
    expect(inserted.data).toMatchObject({
      quantitySheets: 3,
      deltaSheets: 0,
      estimateAffected: false
    });
    expect(aggregate).not.toHaveBeenCalled();
    expect(result.estimatedSheets).toBeNull();
  });

  it("does not create a paper deduction for a failed settlement", async () => {
    const paperCreate = vi.fn();
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
      kioskPaperEvent: { create: paperCreate },
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

    expect(paperCreate).not.toHaveBeenCalled();
  });
});
