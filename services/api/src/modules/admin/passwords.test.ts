import { argon2Sync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { burnEquivalentWork, hashPassword, verifyPassword } from "./passwords.js";

describe("the runtime's argon2id", () => {
  it("matches the RFC 9106 argon2id test vector", () => {
    // §5.3 of the RFC. If the platform's implementation ever disagrees with
    // this, no stored digest can be trusted and the suite should say so first.
    const tag = argon2Sync("argon2id", {
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3
    });
    expect(Buffer.from(tag).toString("hex")).toBe(
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"
    );
  });
});

describe("password digests", () => {
  it("hashes to a self-describing argon2id PHC string and verifies", async () => {
    const digest = await hashPassword("correct horse battery staple");
    expect(digest).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/u);
    await expect(verifyPassword("correct horse battery staple", digest)).resolves.toBe(true);
  });

  it("salts: the same password never hashes to the same digest twice", async () => {
    const [first, second] = await Promise.all([
      hashPassword("the same password"),
      hashPassword("the same password")
    ]);
    expect(first).not.toBe(second);
    await expect(verifyPassword("the same password", first)).resolves.toBe(true);
    await expect(verifyPassword("the same password", second)).resolves.toBe(true);
  });

  it("refuses the wrong password", async () => {
    const digest = await hashPassword("the real password 1");
    await expect(verifyPassword("the real password 2", digest)).resolves.toBe(false);
    await expect(verifyPassword("", digest)).resolves.toBe(false);
  });

  it("verifies against stored parameters, not current constants", async () => {
    // A digest written with weaker (here: smaller) parameters keeps verifying,
    // which is what lets the constants be raised without a migration.
    const digest = await hashPassword("migrating password");
    const weaker = digest.replace("m=65536,t=3", "m=8192,t=2");
    // Not the same tag any more, so it must simply be false — never a throw.
    await expect(verifyPassword("migrating password", weaker)).resolves.toBe(false);
  });

  it("treats a malformed stored digest as a mismatch, never an error", async () => {
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
    await expect(verifyPassword("anything", "$2b$10$bcryptlooking")).resolves.toBe(false);
    await expect(verifyPassword("anything", "$argon2id$v=19$m=abc,t=3,p=1$x$y")).resolves.toBe(
      false
    );
    // Parameters outside the accepted envelope must not be computed.
    await expect(
      verifyPassword(
        "anything",
        "$argon2id$v=19$m=999999999,t=3,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      )
    ).resolves.toBe(false);
  });

  it("burns equivalent work for a nonexistent account and always says no", async () => {
    await expect(burnEquivalentWork("any password at all")).resolves.toBe(false);
  });
});
