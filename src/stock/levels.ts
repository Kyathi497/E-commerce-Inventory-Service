// What shoppers and alerts see of a stock level. Exact counts are never
// public (§6.4), only these buckets.
export type Availability = "in_stock" | "low" | "out";

export function availability(available: number, threshold: number, active = true): Availability {
  if (!active || available <= 0) return "out";
  return available <= threshold ? "low" : "in_stock";
}

// The event to send when a change moves stock across a boundary, if any.
export function levelEvent(before: number, after: number, threshold: number) {
  const from = availability(before, threshold);
  const to = availability(after, threshold);
  if (from === to) return null;
  if (to === "out") return "stock.out" as const;
  if (to === "low") return from === "in_stock" ? ("stock.low" as const) : ("stock.restocked" as const);
  return "stock.restocked" as const;
}
