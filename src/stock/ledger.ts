import type { Prisma } from "../generated/prisma/client.js";
import type { Outbox } from "../lib/events/index.js";
import { levelEvent } from "./levels.js";

export type Tx = Prisma.TransactionClient;

export interface Change {
  stockItemId: string;
  onHandDelta: number;
  reservedDelta: number;
  reason: Prisma.StockMovementCreateManyInput["reason"];
  refType?: string;
  refId?: string;
  actorId?: string;
  note?: string;
}

// Records a change that was just applied to a stock item: the ledger row,
// and a stock.low / stock.out / stock.restocked event if it crossed a
// boundary. Call inside the transaction that made the change.
export async function recordChange(tx: Tx, outbox: Outbox, change: Change, correlationId?: string) {
  await tx.stockMovement.create({ data: change });
  const item = await tx.stockItem.findUniqueOrThrow({ where: { id: change.stockItemId } });
  const after = item.onHand - item.reserved;
  const before = after - (change.onHandDelta - change.reservedDelta);
  const type = levelEvent(before, after, item.lowStockThreshold);
  if (type) {
    await outbox.publish(
      tx,
      type,
      {
        stockItemId: item.id,
        kind: item.kind,
        refId: item.refId,
        name: item.name,
        available: after,
        threshold: item.lowStockThreshold,
      },
      { correlationId },
    );
  }
  return item;
}
