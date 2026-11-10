import { describe, expect, it } from "vitest";
import { availability, levelEvent } from "./levels.js";

describe("availability", () => {
  it("buckets stock without revealing counts", () => {
    expect(availability(5000, 2000)).toBe("in_stock");
    expect(availability(2000, 2000)).toBe("low");
    expect(availability(0, 2000)).toBe("out");
    expect(availability(5000, 2000, false)).toBe("out");
  });
});

describe("levelEvent", () => {
  it("fires only when a boundary is crossed", () => {
    expect(levelEvent(5000, 4000, 2000)).toBeNull();
    expect(levelEvent(5000, 1500, 2000)).toBe("stock.low");
    expect(levelEvent(1500, 0, 2000)).toBe("stock.out");
    expect(levelEvent(5000, 0, 2000)).toBe("stock.out");
    expect(levelEvent(0, 1000, 2000)).toBe("stock.restocked");
    expect(levelEvent(1000, 9000, 2000)).toBe("stock.restocked");
  });
});
