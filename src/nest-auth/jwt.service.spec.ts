import "reflect-metadata";
import { describe, it, expect, afterEach } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { EncryptJWT } from "jose";
import { JwtService } from "./jwt.service";

/**
 * The gateway's JWE, opened — **once, for the whole platform**.
 *
 * ⚠️ THIS FILE REPLACES THREE COPIES (payment-api's, balance-api's,
 * segmentation-api's). What must not drift is the ALGORITHM PAIR — `dir` +
 * `A256GCM`, which is what the gateway encrypts with — and these specs pin it,
 * including the negative case that a token naming a DIFFERENT algorithm is refused.
 */

/** A256GCM needs exactly 32 bytes of key material. */
const KEY = "unit-test-key-exactly-32-bytes!!";

function keyOf(secret: string): Uint8Array {
    return new TextEncoder().encode(secret);
}

const payload = {
    client: { name: "gambitech", permissions: [{ keyword: "X", enabled: true }] },
    user: { id: "u1", username: "alice", roles: ["ADMIN"], permissions: ["Y"] },
};

describe("JwtService", () => {
    const service = new JwtService(KEY);

    it("decrypts a JWE minted with the shared key, alg `dir` + enc `A256GCM`", async () => {
        const token = await new EncryptJWT(payload)
            .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
            .encrypt(keyOf(KEY));

        await expect(service.decryptToken(token)).resolves.toMatchObject(payload);
    });

    it("refuses a token minted with a different key", async () => {
        const token = await new EncryptJWT(payload)
            .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
            .encrypt(keyOf("z".repeat(32)));

        await expect(service.decryptToken(token)).rejects.toThrow(UnauthorizedException);
    });

    it("refuses a structurally invalid token", async () => {
        await expect(service.decryptToken("nonsense")).rejects.toThrow(UnauthorizedException);
    });

    it("⚠️ refuses an EXPIRED token — `jose` enforces `exp` and the refusal must not be swallowed", async () => {
        const token = await new EncryptJWT(payload)
            .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
            .setExpirationTime("-1h")
            .encrypt(keyOf(KEY));

        await expect(service.decryptToken(token)).rejects.toThrow(UnauthorizedException);
    });

    /**
     * ⚠️⚠️ THE ANTI-ALGORITHM-CONFUSION PROPERTY, ASSERTED RATHER THAN ASSUMED. Left
     * unpinned, `jose` accepts whichever algorithm the TOKEN names, so an attacker
     * picks the one they can forge. `A128GCM` here is a perfectly valid JWE that this
     * service must still refuse, because it is not what the gateway produces.
     */
    it("⚠️⚠️ refuses a JWE naming an algorithm OTHER than `dir` + `A256GCM`", async () => {
        const token = await new EncryptJWT(payload)
            .setProtectedHeader({ alg: "dir", enc: "A128GCM" })
            .encrypt(keyOf("sixteen-byte-key"));

        await expect(service.decryptToken(token)).rejects.toThrow(UnauthorizedException);
    });

    it("⚠️ the failure message never echoes the token", async () => {
        const token = "abc.def.ghi.jkl.mno";

        await expect(service.decryptToken(token)).rejects.toThrow(
            expect.objectContaining({ message: expect.not.stringContaining("abc.def") }),
        );
    });
});

/**
 * ⚠️ WHERE THE KEY COMES FROM. Each service provides its OWN
 * `CONFIGURATION.jwt.encryptionKey` through the `JWT_ENCRYPTION_KEY` token, because a
 * service's configuration layer — not this package — owns validating and defaulting
 * it. `process.env.JWT_ENCRYPTION_KEY` is the fallback so a bare `new JwtService()`
 * still works, and NO key at all is a wiring-time throw rather than a service that
 * boots healthy and `401`s every request.
 */
describe("JwtService — key resolution", () => {
    const original = process.env.JWT_ENCRYPTION_KEY;
    afterEach(() => {
        if (original === undefined) delete process.env.JWT_ENCRYPTION_KEY;
        else process.env.JWT_ENCRYPTION_KEY = original;
    });

    it("falls back to process.env.JWT_ENCRYPTION_KEY when no token is provided", async () => {
        process.env.JWT_ENCRYPTION_KEY = KEY;
        const token = await new EncryptJWT(payload)
            .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
            .encrypt(keyOf(KEY));

        await expect(new JwtService().decryptToken(token)).resolves.toMatchObject(payload);
    });

    it("⚠️ THROWS at construction when no key is configured — never a healthy service that 401s everything", () => {
        delete process.env.JWT_ENCRYPTION_KEY;

        expect(() => new JwtService()).toThrow(/JWT encryption key is not configured/);
    });
});
