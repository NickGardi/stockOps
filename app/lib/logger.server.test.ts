import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("logger", () => {
  let consoleSpy: { log: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts accessToken from meta", async () => {
    const { logger } = await import("./logger.server");
    logger.info("test", { accessToken: "shpat_secret", shop: "myshop.myshopify.com" });
    expect(consoleSpy.log).toHaveBeenCalledWith(
      expect.stringContaining("[REDACTED]")
    );
    expect(consoleSpy.log).toHaveBeenCalledWith(
      expect.stringContaining("myshop.myshopify.com")
    );
    expect(consoleSpy.log).not.toHaveBeenCalledWith(
      expect.stringContaining("shpat_secret")
    );
  });

  it("logs message with level", async () => {
    const { logger } = await import("./logger.server");
    logger.info("hello");
    expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining("[INFO]"));
    expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining("hello"));
  });
});
