import { config } from "../config.js";
import type { EventData } from "../lib/contracts/index.js";
import { AppError } from "../lib/common/index.js";
import type { EventHandlers, Outbox } from "../lib/events/index.js";
import { logger } from "../logger.js";
import type { Tx } from "./ledger.js";
import { finishReservation, restockReservation } from "./reservations.service.js";

// Catalog events (§8): every product gets a stock item, named like the product.
export function productHandlers(): EventHandlers<Tx> {
  const upsert = async (tx: Tx, data: EventData<"product.created">, created: boolean) => {
    const status = data.status === "archived" ? "archived" : "active";
    const existing = await tx.stockItem.findUnique({ where: { kind_refId: { kind: "product", refId: data.productId } } });
    if (existing) {
      await tx.stockItem.update({ where: { id: existing.id }, data: { name: data.name, status } });
      return;
    }
    const item = await tx.stockItem.create({
      data: { kind: "product", refId: data.productId, name: data.name, status, lowStockThreshold: config.DEFAULT_LOW_STOCK },
    });
    logger.info({ productId: data.productId, slug: data.slug }, "stock item created for new product");
    if (created && config.DEV_OPENING_STOCK > 0) {
      await tx.stockItem.update({ where: { id: item.id }, data: { onHand: config.DEV_OPENING_STOCK } });
      await tx.stockMovement.create({
        data: {
          stockItemId: item.id,
          onHandDelta: config.DEV_OPENING_STOCK,
          reservedDelta: 0,
          reason: "receive",
          note: "Development opening stock (DEV_OPENING_STOCK)",
        },
      });
    }
  };
  return {
    "product.created": (tx, data) => upsert(tx, data, true),
    "product.updated": (tx, data) => upsert(tx, data, false),
    "product.archived": (tx, data) => upsert(tx, data, false),
  };
}

// Order events (§8): a confirmed order takes its held stock off the shelf; a
// cancelled one gives it back, whether it was still held or already taken.
export function orderHandlers(outbox: Outbox): EventHandlers<Tx> {
  return {
    "order.confirmed": async (tx, data, event) => {
      try {
        await finishReservation(tx, outbox, data.reservationKey, "committed", event.correlationId ?? undefined);
      } catch (err) {
        // The hold expired or was released before the order was confirmed.
        // order-service only confirms with a live hold (a late payment holds
        // stock again first), so this needs a person.
        if (!(err instanceof AppError)) throw err;
        logger.error({ orderId: data.orderId, reservationKey: data.reservationKey, err: err.message }, "confirmed order has no held stock to commit");
      }
    },
    "order.cancelled": async (tx, data, event) => {
      const requestId = event.correlationId ?? undefined;
      const r = await tx.reservation.findUnique({ where: { orderId: data.reservationKey } });
      if (!r) return;
      if (r.status === "held") await finishReservation(tx, outbox, data.reservationKey, "released", requestId);
      else if (r.status === "committed") await restockReservation(tx, outbox, data.reservationKey, requestId);
      // expired or released already: nothing left to give back.
    },
  };
}
