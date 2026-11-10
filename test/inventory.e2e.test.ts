// End-to-end checks for Phase 2's inventory against the running stack
// (`docker compose up --build` in auth-service, api-gateway, catalog-service
// and inventory-service), then:  pnpm test:e2e
// GATEWAY_URL, INVENTORY_URL and AUTH_CONTAINER override the defaults.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { signServiceToken } from "../src/lib/auth-guard/index.js";
import { type Browser, GATEWAY, signedInAdmin } from "./helpers.js";

const INVENTORY = process.env.INVENTORY_URL ?? "http://localhost:4003";
const SECRET = process.env.SERVICE_TOKEN_SECRET ?? "dev-only-service-token-secret-change-me-in-production";

// What order-service will do in phase 4: call inventory with a service token.
async function internal(method: string, path: string, body?: unknown, caller = "order-service") {
  const res = await fetch(`${INVENTORY}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await signServiceToken(SECRET, caller, "inventory-service")}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

let admin: Browser;

// A fresh packaging item with `units` on hand, so tests never touch real stock.
async function stockItem(units: number) {
  const code = `E2E-${randomUUID().slice(0, 8).toUpperCase()}`;
  const created = await admin.call("POST", "/api/v1/admin/stock", { code, name: `E2E jar ${code}`, lowStockThreshold: 2 });
  expect(created.status).toBe(201);
  const received = await admin.call("POST", `/api/v1/admin/stock/${created.data.item.id}/receive`, {
    quantity: units,
    note: "e2e",
  });
  expect(received.status).toBe(200);
  return { id: created.data.item.id as string, code };
}

const line = (code: string, quantity = 1) => ({ kind: "packaging", refId: code, quantity });

beforeAll(async () => {
  admin = await signedInAdmin();
}, 60_000);

describe("reservations", () => {
  it("never oversells: 50 checkouts race for the last 10 units, exactly 10 win", async () => {
    const { id, code } = await stockItem(10);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => internal("POST", "/internal/reservations", { orderId: `e2e-${code}-${i}`, lines: [line(code)] })),
    );
    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status === 409);
    expect(won).toHaveLength(10);
    expect(lost).toHaveLength(40);
    expect(lost[0]!.data).toMatchObject({ code: "STOCK_SHORT", short: [{ refId: code, requested: 1, available: 0 }] });

    const item = (await admin.call("GET", `/api/v1/admin/stock/${id}`)).data.item;
    expect(item).toMatchObject({ onHand: 10, reserved: 10, available: 0, level: "out" });
  }, 60_000);

  it("is idempotent by order id, and commit / release move stock as expected", async () => {
    const { id, code } = await stockItem(5);
    const orderA = `e2e-${code}-a`;
    const first = await internal("POST", "/internal/reservations", { orderId: orderA, lines: [line(code, 2)] });
    const again = await internal("POST", "/internal/reservations", { orderId: orderA, lines: [line(code, 2)] });
    expect(first.status).toBe(201);
    expect(again.data.reservation.id).toBe(first.data.reservation.id);

    const orderB = `e2e-${code}-b`;
    await internal("POST", "/internal/reservations", { orderId: orderB, lines: [line(code, 1)] });

    // Paid: stock leaves the shelf. Repeating the commit changes nothing.
    expect((await internal("POST", `/internal/reservations/${orderA}/commit`)).data.reservation.status).toBe("committed");
    expect((await internal("POST", `/internal/reservations/${orderA}/commit`)).status).toBe(200);
    // Cancelled: the hold is freed. A committed order can't be released.
    expect((await internal("POST", `/internal/reservations/${orderB}/release`)).data.reservation.status).toBe("released");
    expect((await internal("POST", `/internal/reservations/${orderA}/release`)).status).toBe(409);

    const item = (await admin.call("GET", `/api/v1/admin/stock/${id}`)).data.item;
    expect(item).toMatchObject({ onHand: 3, reserved: 0, available: 3 });

    const ledger = (await admin.call("GET", `/api/v1/admin/stock/${id}/movements`)).data.items.map(
      (m: { reason: string }) => m.reason,
    );
    expect(ledger).toEqual(["release", "commit", "reserve", "reserve", "receive"]);
  });

  it("won't let an adjustment eat into stock held for orders", async () => {
    const { id, code } = await stockItem(4);
    await internal("POST", "/internal/reservations", { orderId: `e2e-${code}`, lines: [line(code, 3)] });
    const res = await admin.call("POST", `/api/v1/admin/stock/${id}/adjust`, { delta: -2, reason: "damage", note: "dropped" });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe("BELOW_RESERVED");
    const ok = await admin.call("POST", `/api/v1/admin/stock/${id}/adjust`, { delta: -1, reason: "damage", note: "dropped" });
    expect(ok.data.item).toMatchObject({ onHand: 3, reserved: 3 });
  });

  it("only takes service tokens addressed to inventory, and isn't reachable from outside", async () => {
    const res = await fetch(`${INVENTORY}/internal/reservations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const wrongAudience = await fetch(`${INVENTORY}/internal/reservations/x`, {
      headers: { Authorization: `Bearer ${await signServiceToken(SECRET, "order-service", "catalog-service")}` },
    });
    expect(wrongAudience.status).toBe(401);
    expect((await fetch(`${GATEWAY}/internal/reservations/x`)).status).toBe(404);
  });
});

describe("availability", () => {
  it("tells shoppers in_stock / low / out, never counts", async () => {
    const products = (await fetch(`${GATEWAY}/api/v1/products?limit=100`).then((r) => r.json())).items as { id: string }[];
    const res = await fetch(`${GATEWAY}/api/v1/availability`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ products: products.map((p) => p.id) }),
    });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: Record<string, string> };
    expect(Object.keys(items).length).toBe(products.length);
    for (const level of Object.values(items)) expect(["in_stock", "low", "out"]).toContain(level);
  });
});

describe("events inbox", () => {
  it("handles an event once, however many times it is delivered", async () => {
    const productId = randomUUID();
    const event = {
      id: randomUUID(),
      type: "product.created",
      version: 1,
      occurredAt: new Date().toISOString(),
      source: "catalog-service",
      data: { productId, slug: "e2e-inbox", name: "E2E inbox product", status: "archived" },
    };
    const first = await internal("POST", "/internal/events", event, "catalog-service");
    const second = await internal("POST", "/internal/events", event, "catalog-service");
    expect(first.data.status).toBe("processed");
    expect(second.data.status).toBe("duplicate");
    const unknown = await internal("POST", "/internal/events", { ...event, id: randomUUID(), type: "something.else" }, "catalog-service");
    expect(unknown.data.status).toBe("ignored");
  });
});

describe("admin", () => {
  it("exports stock as CSV", async () => {
    const res = await admin.call("GET", "/api/v1/admin/stock/export.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(String(res.data).split("\r\n")[0]).toBe("kind,ref_id,name,unit,on_hand,reserved,available,low_stock_threshold,status");
  });
});
