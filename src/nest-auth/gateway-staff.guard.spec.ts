import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { GqlExecutionContext } from "@nestjs/graphql";
import { EncryptJWT } from "jose";
import { GatewayStaffGuard, REQUIRE_PERMISSIONS_KEY, requireGatewayStaff } from "./gateway-staff.guard";
import { JwtService } from "./jwt.service";

/**
 * THE PLATFORM'S IDENTITY FLOOR, so its negative cases are the security contract
 * rather than edge-case tidiness. Four services run on this file.
 *
 * ⚠️ The guard reads the request out of the GRAPHQL context, not the HTTP one —
 * `GqlExecutionContext.create(ctx).getContext()` — because every consumer builds the
 * context as `{ req }`. A guard that reached for `ctx.switchToHttp().getRequest()`
 * would find an undefined request under the Apollo driver and throw a 500 where a
 * 401 belongs.
 */

/** A256GCM needs exactly 32 bytes of key material. */
const KEY = "unit-test-key-exactly-32-bytes!!";

/** A GraphQL execution context carrying exactly the headers a spec wants to test. */
function gqlContextWith(headers: Record<string, string>): { context: ExecutionContext; req: Record<string, unknown> } {
    const req: Record<string, unknown> = { headers };
    const context = {
        getType: () => "graphql",
        getArgs: () => [undefined, {}, { req }, undefined],
        getArgByIndex: (i: number) => [undefined, {}, { req }, undefined][i],
        getClass: () => class {},
        getHandler: () => () => undefined,
        switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { context, req };
}

/** Mint a real JWE with the real key, exactly as ybc-api-gateway does. */
async function mintJwe(payload: Record<string, unknown>): Promise<string> {
    return new EncryptJWT(payload).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).encrypt(new TextEncoder().encode(KEY));
}

/** The thrown value, without asserting on a matcher shape `toThrow` may not accept. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
    return promise.then(
        () => {
            throw new Error("expected a rejection, got a resolution");
        },
        (error: Error) => error,
    );
}

const STAFF = {
    client: { name: "gambitech", permissions: [] },
    user: { id: "staff-7", username: "opsAlice", roles: ["ADMIN"], permissions: ["AUTHORIZATION_MANAGEMENT"] },
};

describe("GatewayStaffGuard", () => {
    let guard: GatewayStaffGuard;

    beforeEach(() => {
        guard = new GatewayStaffGuard(new JwtService(KEY), new Reflector());
    });

    it("refuses a request with NO Authorization header", async () => {
        const { context } = gqlContextWith({});

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it("refuses an Authorization header that is not a Bearer token", async () => {
        const { context } = gqlContextWith({ authorization: "Basic dXNlcjpwYXNz" });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it("refuses a garbage Bearer token — it is not a JWE this key can open", async () => {
        const { context } = gqlContextWith({ authorization: "Bearer not-a-real-jwe" });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it("⚠️ refuses a JWE minted with a DIFFERENT key — decryption is the authentication", async () => {
        const wrongKey = new TextEncoder().encode("x".repeat(32));
        const token = await new EncryptJWT(STAFF).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).encrypt(wrongKey);
        const { context } = gqlContextWith({ authorization: `Bearer ${token}` });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    /**
     * ⚠️⚠️ THE HOLE THIS GUARD CLOSED, AND THE REASON THE TWO STATUSES DIFFER. The
     * `JwtAuthGuard` that balance-api and segmentation-api used to run on decrypted,
     * assigned and `return true`d — so this token was ADMITTED. It is a genuine
     * gateway token, which is why the answer is `403` and not `401`: re-authenticating
     * cannot help a token that names nobody.
     */
    it("⚠️⚠️ refuses a VALID JWE with no `user` — a tokenless client identity is not staff (403, not 401)", async () => {
        const token = await mintJwe({ client: { name: "gambitech", permissions: [] } });
        const { context } = gqlContextWith({ authorization: `Bearer ${token}` });

        const error = await rejection(guard.canActivate(context));
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error).not.toBeInstanceOf(UnauthorizedException);
    });

    it("⚠️ an UNDECRYPTABLE token is 401 and not 403 — the two are not interchangeable", async () => {
        const { context } = gqlContextWith({ authorization: "Bearer not-a-real-jwe" });

        const error = await rejection(guard.canActivate(context));
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error).not.toBeInstanceOf(ForbiddenException);
    });

    it("admits a valid staff JWE and exposes the actor as `gatewayUser` on the request", async () => {
        const token = await mintJwe(STAFF);
        const { context, req } = gqlContextWith({ authorization: `Bearer ${token}` });

        await expect(guard.canActivate(context)).resolves.toBe(true);

        expect(req.gatewayUser).toMatchObject({ user: { id: "staff-7", username: "opsAlice" } });
    });

    /**
     * ⚠️⚠️ THE DUAL ATTACH, AND IT IS THE ONLY WAY THIS EXTRACTION CAN BREAK
     * PRODUCTION. `JwtAuthGuard` attached the payload as `req.user`, and FIVE live
     * readers still read it — `maskUnlessFeature` and `PermissionsGuard` at the NESTED
     * path `req.user.user.permissions`, `@CurrentUser()`, and the audit-actor helpers
     * in balance-api and segmentation-api. `maskUnlessFeature` fails CLOSED, so losing
     * `req.user` would return `*****` to EVERYONE including permission holders — data
     * that looks missing rather than an auth error. Both fields, same object, pinned.
     */
    it("⚠️⚠️ sets BOTH `req.user` and `req.gatewayUser`, to the SAME payload object", async () => {
        const token = await mintJwe(STAFF);
        const { context, req } = gqlContextWith({ authorization: `Bearer ${token}` });

        await guard.canActivate(context);

        expect(req.user).toBe(req.gatewayUser);
        expect(req.user).toMatchObject({ user: { id: "staff-7" } });
    });

    it("⚠️⚠️ keeps the NESTED permissions path `req.user.user.permissions` resolvable — PermissionsGuard and maskUnlessFeature read exactly that", async () => {
        const token = await mintJwe(STAFF);
        const { context, req } = gqlContextWith({ authorization: `Bearer ${token}` });

        await guard.canActivate(context);

        const user = req.user as { user?: { permissions?: string[] } };
        expect(user.user?.permissions).toEqual(["AUTHORIZATION_MANAGEMENT"]);
    });

    it("reads the request from the GRAPHQL context, not the HTTP one", async () => {
        const token = await mintJwe(STAFF);
        const { context } = gqlContextWith({ authorization: `Bearer ${token}` });
        const spy = vi.spyOn(GqlExecutionContext, "create");

        await guard.canActivate(context);

        expect(spy).toHaveBeenCalledWith(context);
        spy.mockRestore();
    });

    /**
     * ⚠️ A CONTEXT BUILT WITHOUT A `req` WRAPPER MUST 401, NOT 500. Introspection and
     * non-HTTP execution both produce one; the `gqlContext?.req ?? gqlContext`
     * fallback is what turns it into a missing-header refusal.
     */
    it("⚠️ 401s a GraphQL context carrying no request at all — never a 500", async () => {
        const context = {
            getType: () => "graphql",
            getArgs: () => [undefined, {}, {}, undefined],
            getArgByIndex: (i: number) => [undefined, {}, {}, undefined][i],
            getClass: () => class {},
            getHandler: () => () => undefined,
            switchToHttp: () => ({ getRequest: () => undefined }),
        } as unknown as ExecutionContext;

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it("⚠️ never puts the token or the actor in an exception message", async () => {
        const token = await mintJwe(STAFF);
        const { context } = gqlContextWith({ authorization: `Bearer ${token}x` });

        const error = await rejection(guard.canActivate(context));
        expect(error.message).not.toContain(token);
        expect(error.message).not.toContain("opsAlice");
    });
});

/**
 * ⚠️⚠️ THE METADATA KEY IS PART OF THE CONTRACT, SO IT IS PINNED TO ITS EXACT STRING.
 * `Reflector` matches on the literal, so renaming the constant — or "tidying" the
 * historical `payments` prefix now that the guard is shared — silently stops finding
 * existing declarations, and every keyword-gated operation reverts to the WIDE,
 * identity-only posture. No compile error, no failing test, a real authorization
 * downgrade. This spec is the only thing that would notice.
 */
describe("RequirePermissions", () => {
    it("⚠️⚠️ pins the metadata key to `paymentsRequirePermissions` — a rename is a silent authorization downgrade", () => {
        expect(REQUIRE_PERMISSIONS_KEY).toBe("paymentsRequirePermissions");
    });
});

/**
 * ⚠️⚠️ THE HELPER AND THE GUARD MUST AGREE ABOUT WHERE THE PAYLOAD LIVES, AND FOR A
 * LONG TIME THEY DID NOT.
 *
 * Every consumer builds the context as `{ req }`; the guard resolves
 * `req = gqlContext?.req ?? gqlContext` and attaches the payload as
 * `req.gatewayUser` — i.e. at `ctx.req.gatewayUser`. The helper used to read
 * `ctx.gatewayUser`, one level too high, so a resolver doing
 * `requireGatewayStaff(ctx)` with `@Context() ctx` passed the guard and then threw
 * `A staff identity is required` on EVERY call. It survived being written because
 * the helper had zero callers: payment-api's `provider-credentials.resolver.ts`
 * relies on the guard passing and takes its tenant from arguments.
 *
 * ⚠️ THE NESTED CASE IS THE PRODUCTION SHAPE. A spec that only mocked the flat
 * shape would pass while the service 403'd every request — which is exactly the
 * trap this block exists to close. Both shapes are supported because the guard
 * itself accepts both.
 */
describe("requireGatewayStaff", () => {
    const user = { id: "staff-7", username: "opsAlice", roles: ["ADMIN"], permissions: ["FINANCE_MANAGEMENT"] };

    it("⚠️ reads the actor from the NESTED context shape — `{ req: { gatewayUser } }`, what production sends", () => {
        expect(requireGatewayStaff({ req: { gatewayUser: { user } } })).toEqual({
            id: "staff-7",
            username: "opsAlice",
            roles: ["ADMIN"],
            permissions: ["FINANCE_MANAGEMENT"],
        });
    });

    it("also reads the FLAT shape — `{ gatewayUser }`, which the guard's own fallback can produce", () => {
        expect(requireGatewayStaff({ gatewayUser: { user } })).toMatchObject({ id: "staff-7" });
    });

    it("defaults `roles` and `permissions` to empty arrays rather than undefined", () => {
        const bare = { id: "staff-9", username: "opsBob" };

        expect(requireGatewayStaff({ req: { gatewayUser: { user: bare } } })).toEqual({
            id: "staff-9",
            username: "opsBob",
            roles: [],
            permissions: [],
        });
    });

    it("⚠️ THROWS on a context naming no actor — a resolver that forgot the guard must fail LOUDLY", () => {
        expect(() => requireGatewayStaff(undefined)).toThrow(ForbiddenException);
        expect(() => requireGatewayStaff({})).toThrow(ForbiddenException);
        expect(() => requireGatewayStaff({ req: {} })).toThrow(ForbiddenException);
        expect(() => requireGatewayStaff({ req: { gatewayUser: {} } })).toThrow(ForbiddenException);
    });

    it("⚠️ never names the actor or the token in its refusal message", () => {
        expect(() => requireGatewayStaff({})).toThrow("A staff identity is required");
    });
});

/**
 * ⚠️⚠️ THE KEYWORD + TENANT POSTURE. These cases ARE the security contract of
 * payment-api's withdrawal surface, and they ship together on purpose: a keyword
 * check without a tenant check would let a holder of `_APPROVE` act on EVERY casino's
 * money, which is *wider* than the REST surface it replaced.
 *
 * ⚠️ NO balance-api OR segmentation-api OPERATION DECLARES A KEYWORD, deliberately —
 * both already have a richer tenant rule of their own, and declaring one here would
 * switch on `assertTenant` beside it. The "declares nothing" block at the bottom is
 * therefore the posture those two services actually run on.
 */
describe("GatewayStaffGuard — declared keywords and tenant scoping", () => {
    const KEYWORD = "FINANCE_MANAGEMENT_WITHDRAWALS_APPROVE";

    /**
     * A context that carries headers, resolver ARGS, and the metadata a handler
     * declares. `args` matters: the tenant check reads `casinoIdentifier` from the
     * GraphQL arguments, in both of the two shapes this surface uses.
     */
    function ctx(opts: {
        headers: Record<string, string>;
        args?: Record<string, unknown>;
        required?: string[];
    }): ExecutionContext {
        const req: Record<string, unknown> = { headers: opts.headers };
        const handler = () => undefined;
        if (opts.required) Reflect.defineMetadata(REQUIRE_PERMISSIONS_KEY, opts.required, handler);
        const cls = class {};
        return {
            getType: () => "graphql",
            getArgs: () => [undefined, opts.args ?? {}, { req }, undefined],
            getArgByIndex: (i: number) => [undefined, opts.args ?? {}, { req }, undefined][i],
            getClass: () => cls,
            getHandler: () => handler,
            switchToHttp: () => ({ getRequest: () => req }),
        } as unknown as ExecutionContext;
    }

    async function bearer(payload: Record<string, unknown>): Promise<Record<string, string>> {
        return { authorization: `Bearer ${await mintJwe(payload)}` };
    }

    /**
     * ⚠️⚠️ **`name` AND `identifier` CARRY THE SAME VALUE, AND THE OLD FIXTURE DENIED IT.**
     * It hardcoded `name: "gambitech"` against `identifier: "zambara"` — a token auth-api
     * cannot produce: `extractAuthInfo` sets BOTH from `user.client.identifier`
     * (`name: user.client?.identifier ?? ""`). That divergence is what let the
     * no-identifier test pass for the wrong reason, and it hid a live 403.
     *
     * ⚠️ `nameOnly` IS THE SHAPE THE GATEWAY ACTUALLY SENDS TODAY. `ValidatedUser` declares
     * `identifier?` but `VALIDATE_TOKEN_QUERY` deliberately does NOT request it — a gateway
     * deployed ahead of auth-api would fail `validateToken` outright on an unknown field.
     * So every real JWE has `name` and no `identifier`.
     */
    const staff = (opts: { permissions?: string[]; identifier?: string | null; nameOnly?: boolean }) => {
        const id = opts.identifier === null ? null : (opts.identifier ?? "zambara");
        return {
            client: {
                ...(id === null ? {} : { name: id }),
                ...(id === null || opts.nameOnly ? {} : { identifier: id }),
                permissions: [],
            },
            user: { id: "staff-7", username: "opsAlice", roles: ["ADMIN"], permissions: opts.permissions ?? [] },
        };
    };

    let guard: GatewayStaffGuard;
    beforeEach(() => {
        guard = new GatewayStaffGuard(new JwtService(KEY), new Reflector());
    });

    describe("the keyword check", () => {
        it("admits an actor holding the declared keyword for their own casino", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD] }));

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "zambara" }, required: [KEYWORD] })),
            ).resolves.toBe(true);
        });

        it("⚠️ REFUSES an actor whose permissions lack the declared keyword", async () => {
            const headers = await bearer(staff({ permissions: ["SOMETHING_ELSE"] }));

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "zambara" }, required: [KEYWORD] })),
            ).rejects.toThrow(ForbiddenException);
        });

        it("⚠️⚠️ FAILS CLOSED on an EMPTY permissions array — exactly as the shared secret did", async () => {
            const headers = await bearer(staff({ permissions: [] }));

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "zambara" }, required: [KEYWORD] })),
            ).rejects.toThrow(ForbiddenException);
        });

        it("⚠️⚠️ FAILS CLOSED when `permissions` is absent entirely", async () => {
            const headers = await bearer({
                client: { name: "zambara", identifier: "zambara", permissions: [] },
                user: { id: "staff-7", username: "opsAlice" },
            });

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "zambara" }, required: [KEYWORD] })),
            ).rejects.toThrow(ForbiddenException);
        });

        it("⚠️ keywords do NOT inherit — holding the DIRECTOR keyword does not satisfy _APPROVE", async () => {
            // auth-api's `extractAuthInfo` projects a FLAT list and never walks parent_id.
            // If this ever passed, every approver would be their own financial director.
            const headers = await bearer({
                client: { name: "zambara", identifier: "zambara", permissions: [] },
                user: {
                    id: "staff-7",
                    username: "opsAlice",
                    permissions: ["FINANCE_MANAGEMENT_WITHDRAWALS_DIRECTOR_APPROVE"],
                },
            });

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "zambara" }, required: [KEYWORD] })),
            ).rejects.toThrow(ForbiddenException);
        });

        it("a declaration is an AND — every keyword must be held, not merely one", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD] }));

            await expect(
                guard.canActivate(
                    ctx({ headers, args: { casinoIdentifier: "zambara" }, required: [KEYWORD, "ALSO_THIS"] }),
                ),
            ).rejects.toThrow(ForbiddenException);
        });

        it("⚠️ names the MISSING keyword and nothing about the actor or the token", async () => {
            const headers = await bearer(staff({ permissions: [] }));

            const error = await rejection(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "zambara" }, required: [KEYWORD] })),
            );
            expect(error.message).toContain(KEYWORD);
            expect(error.message).not.toContain("opsAlice");
        });
    });

    describe("⚠️⚠️ tenant scoping", () => {
        it("REFUSES when the requested casino is not the token's own", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD], identifier: "zambara" }));

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "othercasino" }, required: [KEYWORD] })),
            ).rejects.toThrow(ForbiddenException);
        });

        /**
         * 🔴🔴 **THE LIVE 403 THIS FILE FAILED TO CATCH.** `assertTenant` read ONLY
         * `client.identifier`, which the gateway does not send — so EVERY legitimate
         * operator request was refused with "This token names no casino". Observed on demo
         * 2026-10-05 against `adminWithdrawals` and `withdrawalApprovalSettings`, and
         * invisible until the exception filter stopped masking GraphQL errors.
         *
         * ⚠️ The guard failed CLOSED, which is the right direction — and it still rejected
         * 100% of real traffic. Failing closed is not the same as being correct.
         */
        it("🔴 ACCEPTS the shape the gateway actually sends — `name` only, no `identifier`", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD], nameOnly: true }));

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "zambara" }, required: [KEYWORD] })),
            ).resolves.toBe(true);
        });

        it("🔴 still REFUSES a `name`-only token naming a DIFFERENT casino", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD], identifier: "zambara", nameOnly: true }));

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "othercasino" }, required: [KEYWORD] })),
            ).rejects.toThrow(ForbiddenException);
        });

        it("⚠️⚠️ REFUSES a token carrying NEITHER `identifier` NOR `name` — fail closed, never 'skip the check'", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD], identifier: null }));

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "zambara" }, required: [KEYWORD] })),
            ).rejects.toThrow(ForbiddenException);
        });

        it("⚠️ REFUSES when the operation names no casino at all", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD] }));

            await expect(guard.canActivate(ctx({ headers, args: {}, required: [KEYWORD] }))).rejects.toThrow(
                ForbiddenException,
            );
        });

        /**
         * ⚠️⚠️ THE SHAPE SPLIT, PINNED PER-SHAPE. The queries plus approve/send/reconcile
         * take `casinoIdentifier` at the TOP level; reject/cancel/set-settings carry it
         * INSIDE `input`. A guard reading only the top level would 403 those three on
         * every legitimate call — or, if a missing value were waved through, make them
         * the only UNSCOPED mutations on the surface. One representative test would not
         * have caught that, because the whole defect is that they differ.
         */
        it("reads the tenant from `args.casinoIdentifier` (top-level shape)", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD] }));

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "zambara" }, required: [KEYWORD] })),
            ).resolves.toBe(true);
        });

        it("reads the tenant from `args.input.casinoIdentifier` (input-object shape)", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD] }));

            await expect(
                guard.canActivate(
                    ctx({
                        headers,
                        args: { input: { casinoIdentifier: "zambara", id: "wd-1", reason: "no" } },
                        required: [KEYWORD],
                    }),
                ),
            ).resolves.toBe(true);
        });

        it("⚠️ REFUSES a MISMATCH inside the input-object shape too", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD], identifier: "zambara" }));

            await expect(
                guard.canActivate(
                    ctx({
                        headers,
                        args: { input: { casinoIdentifier: "othercasino", id: "wd-1", reason: "no" } },
                        required: [KEYWORD],
                    }),
                ),
            ).rejects.toThrow(ForbiddenException);
        });

        it("⚠️ never echoes either casino identifier back to the caller", async () => {
            const headers = await bearer(staff({ permissions: [KEYWORD], identifier: "zambara" }));

            const error = await rejection(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "othercasino" }, required: [KEYWORD] })),
            );
            expect(error.message).not.toContain("othercasino");
            expect(error.message).not.toContain("zambara");
        });
    });

    describe("⚠️⚠️ an operation declaring NOTHING keeps the old, wider posture", () => {
        it("passes on identity alone, with no keyword and NO tenant check", async () => {
            // This is `providerCredentials` — and EVERY balance-api / segmentation-api
            // operation. It holds no keywords and addresses a casino it does not own, and
            // must still pass, or three admin surfaces break on the day this ships.
            const headers = await bearer(staff({ permissions: [], identifier: "zambara" }));

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "othercasino" } })),
            ).resolves.toBe(true);
        });

        it("an EMPTY keyword list is treated as no declaration, not as deny-all", async () => {
            const headers = await bearer(staff({ permissions: [], identifier: "zambara" }));

            await expect(
                guard.canActivate(ctx({ headers, args: { casinoIdentifier: "othercasino" }, required: [] })),
            ).resolves.toBe(true);
        });

        it("⚠️ still attaches BOTH `req.user` and `req.gatewayUser` on the wide posture", async () => {
            const headers = await bearer(staff({ permissions: [] }));
            const context = ctx({ headers, args: { casinoIdentifier: "zambara" } });

            await guard.canActivate(context);

            const req = (context.getArgs() as Array<{ req?: Record<string, unknown> }>)[2].req!;
            expect(req.user).toBe(req.gatewayUser);
        });
    });
});
