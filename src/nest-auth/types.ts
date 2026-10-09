/**
 * The types the gateway-identity floor is defined in terms of.
 *
 * ⚠️ THIS FILE IS THE UNIFIED VERSION OF WHAT USED TO BE FOUR COPIES — payment-api's
 * `JwtPayload`, balance-api's, segmentation-api's, and the fourth the KYC plan was
 * about to add to member-api. It is deliberately payment-api's version, because that
 * one is the SUPERSET and its two differences are load-bearing (see below).
 */

/**
 * What ybc-api-gateway puts inside the JWE it forwards.
 *
 * ⚠️ `user` IS OPTIONAL HERE AND IS NOT OPTIONAL IN THE GUARD. Decrypting proves
 * the token came from the gateway; it does not prove an ACTOR is attached. The two
 * checks are deliberately separate so the failure modes stay distinguishable —
 * `401` for "this is not our token", `403` for "this token names nobody". Typing
 * `user` as required would make the second case a silent `undefined` read instead.
 *
 * ⚠️ balance-api's and segmentation-api's old copies typed `client` and `user` as
 * REQUIRED, which is the tidier-looking and wrong choice: it erases exactly the
 * distinction the guard exists to draw.
 */
export interface JwtPayload {
    client?: {
        name: string;
        /**
         * The casino's EXTERNAL identifier — the same value that appears in
         * `/api/casinos/{casinoIdentifier}/...` and in every resolver argument.
         *
         * ⚠️⚠️ auth-api HAS ALWAYS SENT THIS; TWO SERVICES SIMPLY NEVER DECLARED IT.
         * `extractAuthInfo` sets `identifier: user.client?.identifier ?? ""`
         * (`apps/gt-auth-api/src/common/utils/permission.util.ts`), so the field is in
         * every gateway JWE. Without it declared, a guard had no way to tell WHICH
         * tenant a staff token belongs to — which is why those GraphQL surfaces were
         * documented as having "no tenant scoping": any staff user could address any
         * casino by changing an argument.
         *
         * ⚠️ OPTIONAL IN THE TYPE, REQUIRED BY THE GUARD'S TENANT CHECK, and that
         * split is the same one `user` makes and for the same reason: decrypting
         * proves the token came from our gateway, it does not prove what the token
         * NAMES. A tenant-scoped operation with no identifier here must fail CLOSED.
         */
        identifier?: string;
        permissions: Array<{
            keyword: string;
            enabled: boolean;
        }>;
    };
    user?: {
        id: string;
        username: string;
        roles?: string[];
        permissions?: string[];
    };
}

/** The actor a resolver may rely on once {@link GatewayStaffGuard} has passed. */
export interface GatewayStaffActor {
    id: string;
    username: string;
    roles: string[];
    permissions: string[];
}

/**
 * What the guard attaches to the request, and what a resolver reads back.
 *
 * ⚠️⚠️ BOTH SHAPES ARE DECLARED BECAUSE BOTH OCCUR, AND THE NESTED ONE IS THE
 * PRODUCTION SHAPE. Every consuming service builds the GraphQL context as
 * `context: ({ req }) => ({ req })` (payment-api, balance-api and segmentation-api
 * all do), so a resolver's `@Context() ctx` is `{ req: { gatewayUser } }`. The flat
 * `{ gatewayUser }` arises only from the guard's own `gqlContext?.req ?? gqlContext`
 * fallback, when a context was built without a `req` wrapper.
 *
 * Declaring only the flat shape is what made `requireGatewayStaff` wrong for its
 * entire life — see that function's note.
 */
export interface GatewayStaffContext {
    req?: { gatewayUser?: JwtPayload };
    gatewayUser?: JwtPayload;
}
