import { HttpException, Injectable } from "@nestjs/common";
import { config } from "../config.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../lib/common/index.js";
import { Outbox, OutboxRelay } from "../lib/events/index.js";
import { logger } from "../logger.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ReserveDto } from "./dto.js";
import { recordChange, type Tx } from "./ledger.js";

const include = { lines: { include: { stockItem: true } } } satisfies Prisma.ReservationInclude;
type ReservationRow = Prisma.ReservationGetPayload<{ include: typeof include }>;

// Many checkouts can wait on the same row at once; give them room.
const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 };

interface Shortage {
  kind: string;
  refId: string;
  name: string | null;
  requested: number;
  available: number;
}

class ShortError extends Error {
  constructor(readonly short: Shortage[]) {
    super("stock short");
  }
}

export function reservationView(r: ReservationRow) {
  return {
    id: r.id,
    orderId: r.orderId,
    status: r.status,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    lines: r.lines.map((l) => ({ kind: l.stockItem.kind, refId: l.stockItem.refId, name: l.stockItem.name, quantity: l.quantity })),
  };
}

const ended = (status: string) =>
  new AppError(409, "RESERVATION_ENDED", `This reservation is ${status}; start a new one.`);

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: Outbox,
    private readonly relay: OutboxRelay,
  ) {}

  async get(orderId: string) {
    const r = await this.prisma.reservation.findUnique({ where: { orderId }, include });
    if (!r) throw new AppError(404, "NOT_FOUND", "No reservation for that order.");
    return { reservation: reservationView(r) };
  }

  // Holds stock for an order (§6.4). Idempotent by orderId. Each line is a
  // conditional UPDATE that only succeeds while enough is free, so stock is
  // never oversold however many checkouts run at once. If any line is short
  // the whole hold is rolled back and the answer lists what ran out.
  async reserve(dto: ReserveDto, requestId?: string) {
    const existing = await this.prisma.reservation.findUnique({ where: { orderId: dto.orderId }, include });
    if (existing) return this.replay(existing);

    // Same item twice in one request: add the quantities up.
    const wanted = new Map<string, { kind: "product" | "packaging"; refId: string; quantity: number }>();
    for (const l of dto.lines) {
      const kind = l.kind ?? "product";
      const key = `${kind}:${l.refId}`;
      const prev = wanted.get(key);
      wanted.set(key, { kind, refId: l.refId, quantity: (prev?.quantity ?? 0) + l.quantity });
    }

    try {
      const reservation = await this.prisma.$transaction(async (tx) => {
        const items = await tx.stockItem.findMany({
          where: { OR: [...wanted.values()].map(({ kind, refId }) => ({ kind, refId })) },
        });
        const byKey = new Map(items.map((i) => [`${i.kind}:${i.refId}`, i]));
        const short: Shortage[] = [];
        const held: { stockItemId: string; quantity: number }[] = [];

        // A fixed order (by id) means two checkouts never wait on each other in a cycle.
        const lines = [...wanted.entries()].sort(([a], [b]) => (byKey.get(a)?.id ?? a).localeCompare(byKey.get(b)?.id ?? b));
        for (const [key, line] of lines) {
          const item = byKey.get(key);
          if (!item) {
            short.push({ kind: line.kind, refId: line.refId, name: null, requested: line.quantity, available: 0 });
            continue;
          }
          const updated = await tx.$executeRaw`
            UPDATE StockItem SET reserved = reserved + ${line.quantity}, version = version + 1, updatedAt = UTC_TIMESTAMP(3)
            WHERE id = ${item.id} AND status = 'active' AND onHand - reserved >= ${line.quantity}`;
          if (updated === 0) {
            short.push({ kind: line.kind, refId: line.refId, name: item.name, requested: line.quantity, available: 0 });
          } else {
            held.push({ stockItemId: item.id, quantity: line.quantity });
          }
        }
        if (short.length) throw new ShortError(short);

        const created = await tx.reservation.create({
          data: {
            orderId: dto.orderId,
            expiresAt: new Date(Date.now() + (dto.ttlSeconds ?? config.RESERVATION_TTL_SECONDS) * 1000),
            lines: { create: held },
          },
          include,
        });
        for (const h of held) {
          await recordChange(
            tx,
            this.outbox,
            { stockItemId: h.stockItemId, onHandDelta: 0, reservedDelta: h.quantity, reason: "reserve", refType: "order", refId: dto.orderId },
            requestId,
          );
        }
        return created;
      }, TX_OPTIONS);
      this.relay.kick();
      return { reservation: reservationView(reservation) };
    } catch (err) {
      if (err instanceof ShortError) throw await this.shortAnswer(err.short);
      // Two requests for the same order raced; the other one won.
      if ((err as { code?: string }).code === "P2002") {
        const winner = await this.prisma.reservation.findUnique({ where: { orderId: dto.orderId }, include });
        if (winner) return this.replay(winner);
      }
      throw err;
    }
  }

  // Payment captured: the held stock leaves the shelf.
  async commit(orderId: string, requestId?: string) {
    return this.finish(orderId, "committed", requestId);
  }

  // Order cancelled or payment failed: the held stock is free again.
  async release(orderId: string, requestId?: string) {
    return this.finish(orderId, "released", requestId);
  }

  // Holds whose payment window passed. Safe to run in every replica: each
  // reservation is moved out of `held` by exactly one conditional update.
  async expireDue(limit = 50) {
    const due = await this.prisma.reservation.findMany({
      where: { status: "held", expiresAt: { lt: new Date() } },
      select: { orderId: true },
      take: limit,
    });
    let expired = 0;
    for (const { orderId } of due) {
      try {
        await this.finish(orderId, "expired");
        expired++;
      } catch (err) {
        if (!(err instanceof AppError)) logger.error({ err, orderId }, "reservation expiry failed");
      }
    }
    if (expired) logger.info({ expired }, "expired stale reservations");
    return expired;
  }

  private async finish(orderId: string, to: "committed" | "released" | "expired", requestId?: string) {
    const reservation = await this.prisma.$transaction((tx) => finishReservation(tx, this.outbox, orderId, to, requestId), TX_OPTIONS);
    this.relay.kick();
    return { reservation: reservationView(reservation) };
  }

  private replay(existing: ReservationRow) {
    if (existing.status === "held" || existing.status === "committed") return { reservation: reservationView(existing) };
    throw ended(existing.status);
  }

  // 409 listing each short line with what is actually free right now.
  private async shortAnswer(short: Shortage[]) {
    const items = await this.prisma.stockItem.findMany({
      where: { OR: short.map(({ kind, refId }) => ({ kind: kind as "product" | "packaging", refId })) },
    });
    const free = new Map(items.map((i) => [`${i.kind}:${i.refId}`, i.status === "active" ? Math.max(0, i.onHand - i.reserved) : 0]));
    return new HttpException(
      {
        error: "Some items just ran out. Please reduce the quantity or remove them.",
        code: "STOCK_SHORT",
        short: short.map((s) => ({ ...s, available: free.get(`${s.kind}:${s.refId}`) ?? 0 })),
      },
      409,
    );
  }
}

// Moves a held reservation to committed, released or expired, inside the
// caller's transaction. Repeating the same move is fine; anything else is a
// 409 RESERVATION_ENDED.
export async function finishReservation(
  tx: Tx,
  outbox: Outbox,
  orderId: string,
  to: "committed" | "released" | "expired",
  requestId?: string,
) {
  const { count } = await tx.reservation.updateMany({ where: { orderId, status: "held" }, data: { status: to } });
  const r = await tx.reservation.findUnique({ where: { orderId }, include });
  if (!r) throw new AppError(404, "NOT_FOUND", "No reservation for that order.");
  if (count === 0) {
    if (r.status === to) return r;
    throw ended(r.status);
  }
  for (const line of r.lines) await applyFinish(tx, outbox, line, to, orderId, requestId);
  if (to === "expired") {
    await outbox.publish(tx, "reservation.expired", { reservationId: r.id, orderId }, { correlationId: requestId });
  }
  return tx.reservation.findUniqueOrThrow({ where: { orderId }, include });
}

// A confirmed order was cancelled before it shipped: the committed stock goes
// back on the shelf (ledger reason "return") and the reservation is released.
export async function restockReservation(tx: Tx, outbox: Outbox, orderId: string, requestId?: string) {
  const { count } = await tx.reservation.updateMany({ where: { orderId, status: "committed" }, data: { status: "released" } });
  if (count === 0) return false;
  const r = await tx.reservation.findUniqueOrThrow({ where: { orderId }, include });
  for (const line of r.lines) {
    await tx.$executeRaw`
      UPDATE StockItem SET onHand = onHand + ${line.quantity}, version = version + 1, updatedAt = UTC_TIMESTAMP(3) WHERE id = ${line.stockItemId}`;
    await recordChange(
      tx,
      outbox,
      { stockItemId: line.stockItemId, onHandDelta: line.quantity, reservedDelta: 0, reason: "return", refType: "order", refId: orderId, note: "Order cancelled before shipping" },
      requestId,
    );
  }
  return true;
}

async function applyFinish(
  tx: Tx,
  outbox: Outbox,
  line: { stockItemId: string; quantity: number },
  to: "committed" | "released" | "expired",
  orderId: string,
  requestId?: string,
) {
  const q = line.quantity;
  if (to === "committed") {
    await tx.$executeRaw`
      UPDATE StockItem SET onHand = onHand - ${q}, reserved = reserved - ${q}, version = version + 1, updatedAt = UTC_TIMESTAMP(3) WHERE id = ${line.stockItemId}`;
  } else {
    await tx.$executeRaw`
      UPDATE StockItem SET reserved = reserved - ${q}, version = version + 1, updatedAt = UTC_TIMESTAMP(3) WHERE id = ${line.stockItemId}`;
  }
  await recordChange(
    tx,
    outbox,
    {
      stockItemId: line.stockItemId,
      onHandDelta: to === "committed" ? -q : 0,
      reservedDelta: -q,
      reason: to === "committed" ? "commit" : to === "expired" ? "expire" : "release",
      refType: "order",
      refId: orderId,
    },
    requestId,
  );
}
