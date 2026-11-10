import { envList, loadConfig, nodeEnv } from "./lib/common/index.js";
import { z } from "zod";

// Dev-only default so services agree out of the box; production must set its own.
const DEV_SERVICE_TOKEN_SECRET = "dev-only-service-token-secret-change-me-in-production";

const schema = z
  .object({
    NODE_ENV: nodeEnv,
    PORT: z.coerce.number().int().default(4003),

    DB_HOST: z.string().default("localhost"),
    DB_PORT: z.coerce.number().int().default(3306),
    MYSQL_USER: z.string().min(1),
    MYSQL_PASSWORD: z.string().min(1),
    MYSQL_DATABASE: z.string().min(1),

    // auth-service's public keys, for checking admin tokens.
    AUTH_JWKS_URL: z.url().default("http://localhost:4001/internal/.well-known/jwks.json"),
    // Shared by every service for service-to-service tokens (§7). At least 32 characters.
    SERVICE_TOKEN_SECRET: z.string().min(32).default(DEV_SERVICE_TOKEN_SECRET),

    // How long a checkout holds stock while the customer pays (§6.4).
    RESERVATION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(15 * 60),
    EXPIRY_SWEEP_SECONDS: z.coerce.number().int().positive().default(30),
    // Grams left at which a product counts as running low.
    DEFAULT_LOW_STOCK: z.coerce.number().int().min(0).default(2000),
    // Development only: grams each new product starts with, so the store is
    // shoppable straight after seeding. Recorded in the ledger as a receipt.
    DEV_OPENING_STOCK: z.coerce.number().int().min(0).default(0),

    // Who receives inventory events (§8). Empty = that consumer isn't running yet.
    ORDER_EVENTS_URL: z.url().optional(),
    NOTIFICATION_EVENTS_URL: z.url().optional(),
    // Seconds between delivery attempts, e.g. "2,5,10" in development.
    EVENT_RETRY_DELAYS: envList([]),
  })
  .refine((c) => c.NODE_ENV !== "production" || c.SERVICE_TOKEN_SECRET !== DEV_SERVICE_TOKEN_SECRET, {
    message: "SERVICE_TOKEN_SECRET must be set in production",
    path: ["SERVICE_TOKEN_SECRET"],
  })
  .refine((c) => c.NODE_ENV !== "production" || c.DEV_OPENING_STOCK === 0, {
    message: "DEV_OPENING_STOCK is for development only; receive real stock through the admin API",
    path: ["DEV_OPENING_STOCK"],
  });

export const config = loadConfig(schema);
export type Config = typeof config;

export const SERVICE_NAME = "inventory-service";
