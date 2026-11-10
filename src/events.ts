import { config } from "./config.js";
import type { EventType } from "./lib/contracts/index.js";

// Who receives inventory events (§8). Consumer names are also the
// service-token audience. notification-service arrives in phase 5: until its
// URL is set, its copies aren't recorded.
export const CONSUMERS = {
  "order-service": config.ORDER_EVENTS_URL,
  "notification-service": config.NOTIFICATION_EVENTS_URL,
};

export const ROUTES: Partial<Record<EventType, (keyof typeof CONSUMERS)[]>> = {
  "stock.low": ["notification-service"],
  "stock.out": ["notification-service"],
  "stock.restocked": ["notification-service"],
  "reservation.expired": ["order-service"],
};
