import { Inject, Injectable, Optional, UnauthorizedException } from "@nestjs/common";
import { jwtDecrypt } from "jose";
import { JwtPayload } from "./types";

/**
 * Injection token for the shared JWE key, so each service keeps passing its OWN
 * `CONFIGURATION.jwt.encryptionKey` rather than this package reaching into an
 * environment it does not own.
 *
 * ⚠️ IT IS OPTIONAL ON PURPOSE AND THE FALLBACK IS `process.env.JWT_ENCRYPTION_KEY`,
 * the one variable all four services already read. Providing the token is still the
 * right thing to do — a service whose configuration layer validates, trims or
 * defaults the key must be the one that decides its value, not this file.
 */
export const JWT_ENCRYPTION_KEY = "GT_JWT_ENCRYPTION_KEY";

/**
 * Opens the gateway's JWE. **One definition for the whole platform.**
 *
 * ⚠️⚠️ THIS REPLACES FOUR COPIES, AND THE NOTE IT REPLACES ARGUED AGAINST DOING SO.
 * payment-api's copy carried: *"A DELIBERATE COPY … not a shared package … a new
 * shared package on the auth path would have to be versioned in lockstep across five
 * services."* That reasoning does not apply to `gt-shared-lib`: it is **workspace-only**,
 * consumed at `*` by every dependent, built ahead of them by Turbo `dependsOn`, and
 * never published to npm — so there is **no semver to negotiate** and "lockstep across
 * five services" is already the status quo for the Kafka SDK next door. Extraction
 * reuses an existing coupling instead of creating a new one. What the copies actually
 * bought was DRIFT: three of them disagreed about whether `client.identifier` exists,
 * so a field auth-api has always sent was invisible to two services.
 *
 * ⚠️⚠️ THE ALGORITHM PAIR IS PINNED, AND THAT IS THE SECURITY PROPERTY. `jose`
 * would otherwise accept any algorithm the TOKEN names, which is the classic JWT
 * algorithm-confusion hole: an attacker picks the algorithm they can forge. The
 * allow-list is exactly what the gateway produces — `dir` key management,
 * `A256GCM` content encryption — and nothing else.
 *
 * ⚠️ EVERY FAILURE COLLAPSES TO ONE MESSAGE THAT ECHOES NOTHING. A distinct
 * message per cause (bad key vs. expired vs. malformed) is an oracle, and
 * interpolating the token would write a live credential into the log.
 *
 * ⚠️ CONSTRUCTOR PARAMS CARRY AN EXPLICIT `@Inject`, AND THAT IS NOT STYLE. This
 * package is bundled by tsup/esbuild, which implements `experimentalDecorators` but
 * **not** `emitDecoratorMetadata` — so `design:paramtypes` is never emitted and Nest
 * would resolve this class as having zero dependencies. See the same note on
 * {@link GatewayStaffGuard}; removing an `@Inject` here breaks DI at runtime, not at
 * compile time.
 */
@Injectable()
export class JwtService {
    private readonly encryptionKey: Uint8Array;

    constructor(@Optional() @Inject(JWT_ENCRYPTION_KEY) encryptionKey?: string) {
        const key = encryptionKey ?? process.env.JWT_ENCRYPTION_KEY ?? "";
        if (!key) {
            /**
             * ⚠️ FAIL AT WIRING TIME, NOT PER REQUEST. An empty key cannot open any
             * token, so the alternative is a service that boots healthy and answers
             * `401` to every authenticated request — a misconfiguration that reads as
             * an auth-api outage.
             */
            throw new Error(
                "JWT encryption key is not configured: provide the JWT_ENCRYPTION_KEY provider token or set process.env.JWT_ENCRYPTION_KEY",
            );
        }
        this.encryptionKey = new TextEncoder().encode(key);
    }

    async decryptToken(token: string): Promise<JwtPayload> {
        try {
            const { payload } = await jwtDecrypt(token, this.encryptionKey, {
                keyManagementAlgorithms: ["dir"],
                contentEncryptionAlgorithms: ["A256GCM"],
            });

            return payload as unknown as JwtPayload;
        } catch {
            throw new UnauthorizedException("Invalid or expired token");
        }
    }
}
