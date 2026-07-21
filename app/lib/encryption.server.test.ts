import { describe, it, expect, beforeEach } from "vitest";

// Set key before importing (encryption reads process.env at call time)
beforeEach(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

describe("encryption", () => {
  it("encrypts and decrypts round-trip", async () => {
    const { encrypt, decrypt } = await import("./encryption.server");
    const plain = "shpat_abc123secret";
    const encrypted = encrypt(plain);
    expect(encrypted).not.toBe(plain);
    expect(encrypted).not.toContain("shpat");
    expect(decrypt(encrypted)).toBe(plain);
  });

  it("produces different ciphertext for same plaintext (IV randomness)", async () => {
    const { encrypt } = await import("./encryption.server");
    const a = encrypt("token");
    const b = encrypt("token");
    expect(a).not.toBe(b);
  });

  it("throws when ENCRYPTION_KEY is missing", async () => {
    delete process.env.ENCRYPTION_KEY;
    const { encrypt } = await import("./encryption.server");
    expect(() => encrypt("x")).toThrow("ENCRYPTION_KEY");
  });
});
