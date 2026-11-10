import { Injectable } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError, decodeCursor, toPage } from "../lib/common/index.js";
import { Outbox, OutboxRelay } from "../lib/events/index.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { AdjustDto, CreatePackagingDto, ListStockQuery, ReceiveDto, ReservationsQuery, UpdateStockDto } from "./dto.js";
import { recordChange, type Tx } from "./ledger.js";
import { availability } from "./levels.js";
import { reservationView } from "./reservations.service.js";

type StockRow = Prisma.StockItemGetPayload<object>;

export interface Actor {
  id: string;
  requestId?: string;
}

export function stockView(i: StockRow) {
  const available = i.onHand - i.reserved;
  return {
    id: i.id,
    kind: i.kind,
    refId: i.refId,
    name: i.name,
    unit: i.unit,
    onHand: i.onHand,
    reserved: i.reserved,
    available,
    lowStockThreshold: i.lowStockThreshold,
    level: availability(available, i.lowStockThreshold, i.status === "active"),
    status: i.status,
    version: i.version,
    updatedAt: i.updatedAt,
  };
}

const notFound = () => new AppError(404, "NOT_FOUND", "We couldn't find that stock item.");

@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: Outbox,
    private readonly relay: OutboxRelay,
  ) {}

  // Public: in_stock / low / out per product, never counts (§6.4).
  async availability(productIds: string[]) {
    const ids = [...new Set(productIds.map((s) => s.trim()).filter(Boolean))].slice(0, 100);
    const rows = ids.length ? await this.prisma.stockItem.findMany({ where: { kind: "product", refId: { in: ids } } }) : [];
    return {
      items: Object.fromEntries(
        rows.map((r) => [r.refId, availability(r.onHand - r.reserved, r.lowStockThreshold, r.status === "active")]),
      ),
    };
  }

  async list(query: ListStockQuery) {
    const rows = await this.prisma.stockItem.findMany({
      where: {
        ...(query.kind && { kind: query.kind }),
        ...(query.status && { status: query.status }),
        ...(query.q && { OR: [{ name: { contains: query.q } }, { refId: { contains: query.q } }] }),
      },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    });
    const items = rows.map(stockView);
    return { items: query.low === "true" ? items.filter((i) => i.level !== "in_stock") : items };
  }

  async get(id: string) {
    const item = await this.prisma.stockItem.findUnique({ where: { id } });
    if (!item) throw notFound();
    return { item: stockView(item) };
  }

  async movements(id: string, limit = 50, cursorValue?: string) {
    const cursor = decodeCursor<{ id: string }>(cursorValue);
    const rows = await this.prisma.stockMovement.findMany({
      where: { stockItemId: id },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor.id }, skip: 1 }),
    });
    return toPage(rows, limit, (m) => ({ id: m.id }));
  }

  async reservations(query: ReservationsQuery) {
    const limit = query.limit ?? 50;
    const cursor = decodeCursor<{ id: string }>(query.cursor);
    const rows = await this.prisma.reservation.findMany({
      where: query.status ? { status: query.status } : {},
      include: { lines: { include: { stockItem: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor.id }, skip: 1 }),
    });
    const page = toPage(rows, limit, (r) => ({ id: r.id }));
    return { items: page.items.map(reservationView), nextCursor: page.nextCursor };
  }

  // A delivery of raw stock arrived.
  async receive(actor: Actor, id: string, dto: ReceiveDto) {
    return this.write(actor, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE StockItem SET onHand = onHand + ${dto.quantity}, version = version + 1, updatedAt = UTC_TIMESTAMP(3) WHERE id = ${id}`;
      if (updated === 0) throw notFound();
      const item = await recordChange(
        tx,
        this.outbox,
        { stockItemId: id, onHandDelta: dto.quantity, reservedDelta: 0, reason: "receive", actorId: actor.id, note: dto.note },
        actor.requestId,
      );
      await audit(tx, actor, "stock.receive", id, { quantity: dto.quantity });
      return { item: stockView(item) };
    });
  }

  // A stock count correction, spoilage, or a return put back on the shelf.
  async adjust(actor: Actor, id: string, dto: AdjustDto) {
    return this.write(actor, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE StockItem SET onHand = onHand + ${dto.delta}, version = version + 1, updatedAt = UTC_TIMESTAMP(3)
        WHERE id = ${id} AND onHand + ${dto.delta} >= reserved`;
      if (updated === 0) {
        if (!(await tx.stockItem.count({ where: { id } }))) throw notFound();
        throw new AppError(409, "BELOW_RESERVED", "That would leave less stock than is held for open orders.", {
          delta: "Too much to remove: some of this stock is held for orders being paid for.",
        });
      }
      const item = await recordChange(
        tx,
        this.outbox,
        { stockItemId: id, onHandDelta: dto.delta, reservedDelta: 0, reason: dto.reason, actorId: actor.id, note: dto.note },
        actor.requestId,
      );
      await audit(tx, actor, "stock.adjust", id, { delta: dto.delta, reason: dto.reason });
      return { item: stockView(item) };
    });
  }

  async update(actor: Actor, id: string, dto: UpdateStockDto) {
    const { version, ...fields } = dto;
    return this.write(actor, async (tx) => {
      const { count } = await tx.stockItem.updateMany({ where: { id, version }, data: { ...fields, version: { increment: 1 } } });
      if (count === 0) {
        if (!(await tx.stockItem.count({ where: { id } }))) throw notFound();
        throw new AppError(409, "VERSION_CONFLICT", "Someone else saved a change to this first. Reload to see it, then try again.");
      }
      await audit(tx, actor, "stock.update", id, { fields: Object.keys(fields).filter((k) => fields[k as keyof typeof fields] !== undefined) });
      return { item: stockView(await tx.stockItem.findUniqueOrThrow({ where: { id } })) };
    });
  }

  async createPackaging(actor: Actor, dto: CreatePackagingDto) {
    return this.write(actor, async (tx) => {
      const exists = await tx.stockItem.count({ where: { kind: "packaging", refId: dto.code } });
      if (exists) throw new AppError(409, "ALREADY_EXISTS", "That code is already used.", { code: "That code is already used." });
      const item = await tx.stockItem.create({
        data: {
          kind: "packaging",
          refId: dto.code,
          name: dto.name,
          unit: "pcs",
          lowStockThreshold: dto.lowStockThreshold ?? 50,
        },
      });
      await audit(tx, actor, "stock.create", item.id, { code: dto.code });
      return { item: stockView(item) };
    });
  }

  async exportCsv() {
    const rows = await this.prisma.stockItem.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] });
    const header = ["kind", "ref_id", "name", "unit", "on_hand", "reserved", "available", "low_stock_threshold", "status"];
    const lines = rows.map((r) =>
      [r.kind, r.refId, r.name, r.unit, r.onHand, r.reserved, r.onHand - r.reserved, r.lowStockThreshold, r.status].map(csvCell).join(","),
    );
    return [header.join(","), ...lines].join("\r\n") + "\r\n";
  }

  private async write<T>(actor: Actor, fn: (tx: Tx) => Promise<T>) {
    const result = await this.prisma.$transaction(fn);
    this.relay.kick();
    return result;
  }
}

function audit(tx: Tx, actor: Actor, action: string, target: string, meta: Prisma.InputJsonValue) {
  return tx.auditLog.create({ data: { action, actorId: actor.id, target, meta } });
}

// Spreadsheet-safe: quotes when needed, and a leading = + - @ can't start a formula.
function csvCell(value: string | number) {
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
