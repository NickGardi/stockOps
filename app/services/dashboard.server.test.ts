import { describe, it, expect } from "vitest";
import { computeDaysOfCover } from "./dashboard.server";

describe("dashboard.server", () => {
  describe("computeDaysOfCover", () => {
    it("returns (onHand + onOrder) / avgDailySales when avgDailySales > 0", () => {
      expect(computeDaysOfCover(10, 0, 2)).toBe(5);
      expect(computeDaysOfCover(7, 3, 1)).toBe(10);
      expect(computeDaysOfCover(15, 0, 3)).toBe(5);
    });

    it("returns null when avgDailySales is 0", () => {
      expect(computeDaysOfCover(10, 0, 0)).toBe(null);
      expect(computeDaysOfCover(0, 0, 0)).toBe(null);
    });

    it("returns 0 when onHand+onOrder is 0 and avgDailySales > 0", () => {
      expect(computeDaysOfCover(0, 0, 5)).toBe(0);
    });
  });
});
