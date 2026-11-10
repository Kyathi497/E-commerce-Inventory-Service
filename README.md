# inventory-service

Stock (grams per product, plus optional packaging), reservations, stock ledger. Port 4003.

## Run

```sh
docker network create tej-net   # once per machine
docker compose up --build       # service + MySQL (3309)
```

Stock items are created from catalog-service's `product.created` events. In development every new product
starts with 25 kg (`DEV_OPENING_STOCK`, recorded in the ledger); in production that must be 0 and stock is
received through the admin API.

Hot reload: `docker compose up mysql`, then `pnpm install && pnpm dev` (uses `.env`, see `.env.example`).

## API

| Endpoint | Who |
|---|---|
| `POST /api/v1/availability` `{ "products": [<id>, ...] }` (max 100) → `in_stock` / `low` / `out` | public |
| `GET /api/v1/admin/stock?kind=&low=true&q=`, `GET /api/v1/admin/stock/export.csv` | admin |
| `POST /api/v1/admin/stock` (packaging item), `GET/PATCH /api/v1/admin/stock/:id` | admin |
| `POST /api/v1/admin/stock/:id/receive`, `POST /api/v1/admin/stock/:id/adjust`, `GET …/:id/movements` | admin |
| `GET /api/v1/admin/reservations?status=` | admin |
| `GET /api/v1/admin/events/inventory/deliveries`, `POST …/:eventId/retry` | admin |
| `POST /internal/reservations`, `GET /internal/reservations/:orderId` | order-service (service token) |
| `POST /internal/reservations/:orderId/commit`, `…/release` | order-service (service token) |
| `POST /internal/events` | other services' event relays |

Reservations are idempotent by order ID and can never oversell: each line is a conditional update, and a
database CHECK keeps `0 <= reserved <= onHand`. Unpaid holds expire after 15 minutes.

## Commands

- `pnpm test`: unit tests · `pnpm test:e2e`: end-to-end (whole stack running), including 50 parallel checkouts
- `pnpm migrate:dev` / `pnpm migrate:deploy`: Prisma migrations

## Shared code

`src/lib/common`, `auth-guard`, `contracts`, `events` and `http-client` are shared libraries copied into this
service. If you fix a bug in one, make the same fix in every other service that has a copy.
