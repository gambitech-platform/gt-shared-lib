import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject,
    Injectable,
    SetMetadata,
    UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { GqlExecutionContext } from "@nestjs/graphql";
import { JwtService } from "./jwt.service";
import { GatewayStaffActor, GatewayStaffContext, JwtPayload } from "./types";

/**
 * Metadata key for {@link RequirePermissions}. Internal — declare keywords with the decorator.
 *
 * ⚠️⚠️ THE STRING IS HISTORICAL AND MUST NOT BE "TIDIED". It was minted in payment-api
 * (hence `payments…`) and `Reflector` matches on the LITERAL STRING, so renaming it
 * silently stops finding existing declarations and every keyword-gated operation
 * quietly reverts to the wide, identity-only posture. That is a silent authorization
 * DOWNGRADE with no compile error and no failing test unless one pins the key — which
 * `gateway-staff.guard.spec.ts` now does.
 */
export const REQUIRE_PERMISSIONS_KEY = "paymentsRequirePermissions";

/**
 * Declare the auth-api permission keywords an operation needs.
 *
 * ⚠️⚠️ DECLARING A KEYWORD DOES TWO THINGS, NOT ONE. It turns on the keyword check
 * **and** it turns on TENANT SCOPING — see {@link GatewayStaffGuard}. The two are
 * deliberately coupled: a keyword-gated operation addresses one casino by argument,
 * and a permission check without a tenant check would let a holder of `_APPROVE` act
 * on every casino's money.
 *
 * ⚠️⚠️ THAT COUPLING IS WHY balance-api AND segmentation-api DECLARE **NOTHING**
 * TODAY. Both already enforce tenancy with a RICHER rule of their own —
 * `GraphqlTenantScope` / `TenantScope`, which have a platform tier
 * (`AUTHORIZATION_MANAGEMENT_GENERAL_ACCESS` + `CLIENTS_VIEW` → any casino) and
 * resolve `clientId → identifier`. Declaring a keyword on one of their operations
 * would switch on `assertTenant` BESIDE that richer rule and refuse every platform
 * admin using the dashboard's casino picker. Keyword coverage for those services
 * belongs to `admin-graphql-only-audit.md`, which owns the keyword catalogue.
 *
 * ⚠️ AN OPERATION THAT DECLARES **NOTHING** KEEPS THE OLD, WIDER POSTURE — identity
 * only, no tenant scoping. That is not an oversight: payment-api's
 * `providerCredentials` is documented as having exactly that posture until its own
 * plan narrows it, and making the absence of this decorator mean "deny" would break
 * it on the day this shipped. The consequence to remember is the uncomfortable one:
 * **a new money-surface operation added WITHOUT this decorator silently gets the wide
 * posture.** Declare it.
 */
export const RequirePermissions = (...keywords: string[]) => SetMetadata(REQUIRE_PERMISSIONS_KEY, keywords);

/**
 * THE identity floor on every admin GraphQL surface in the platform — payment-api,
 * balance-api and segmentation-api, with member-api next.
 *
 * ⚠️⚠️ WHAT IT REPLACED, AND THE HOLE THAT CLOSED. balance-api and segmentation-api ran
 * on a `JwtAuthGuard` that decrypted the JWE, assigned it to `req.user` and
 * `return true` — with **no `payload.user?.id` check**. A genuine gateway token
 * naming NO actor was admitted, and `401` ("not our token") and `403` ("ours, names
 * nobody") were collapsed into one answer, only one of which is fixable by
 * re-authenticating. This guard is the same idea written later with that hole closed.
 *
 * ⚠️⚠️ WHY "A `user` IS PRESENT" REALLY DOES MEAN "STAFF" HERE, spelled out because the
 * inference is NOT local and a reviewer who assumes the obvious reaches the opposite
 * conclusion (Codex did, 2026-09-30, reading this as "a player could manage credentials").
 * The chain is:
 *   - the only way to get a token this guard accepts is for ybc-api-gateway to mint it, and
 *     the gateway mints one ONLY after `AuthService.validateToken` succeeds against
 *     **ybc-auth-api**;
 *   - auth-api's `UserEntity` is the STAFF store — `client_id` + `userRoles` + client
 *     features. Its `extractAuthInfo` derives `user.permissions` from roles × the client's
 *     enabled features;
 *   - **players are not auth-api users.** A player is a `members` row in ybc-casino-api and
 *     authenticates *directly against casino-api* with casino-api's own JWT — the player
 *     frontend's `NEXT_PUBLIC_GRAPHQL_ENDPOINT` is casino-api's public URL, not the
 *     gateway's. A player therefore holds no auth-api session token, so
 *     `validateToken` refuses them and no gateway JWE is ever minted for a player.
 * ⚠️ IF THAT EVER CHANGES — if players are onboarded into auth-api, or the player frontend
 * is moved behind the gateway — this guard becomes a privilege-escalation hole on the same
 * day, and the fix is the permission check below, not a patch here.
 *
 * ⚠️⚠️ THIS GUARD HAS **TWO POSTURES**, SELECTED BY WHETHER AN OPERATION DECLARES
 * {@link RequirePermissions}. Read this before adding anything behind it.
 *
 * | Operation declares… | What is enforced |
 * |---|---|
 * | **nothing** | identity only — *"a gateway-authenticated staff identity is present"*. **No per-operation authority and NO tenant scoping**: `casinoIdentifier` is just an argument, so any staff user may address any tenant (PRD §9.1) unless the SERVICE adds its own tenant layer — balance-api and segmentation-api both do. |
 * | **keywords** | identity **+** every named keyword **+** the tenant: the `casinoIdentifier` argument must equal the token's own `client.identifier ?? client.name`. |
 *
 * The wide posture is what payment-api's `providerCredentials` still runs on,
 * deliberately — its page is additionally gated behind
 * `AUTHORIZATION_MANAGEMENT_GENERAL_ACCESS`, so the UI is narrower than this backend
 * rule, and its own plan owns narrowing it. It is also the posture every balance-api
 * and segmentation-api operation runs on, on purpose: see {@link RequirePermissions}.
 * ⚠️ **The uncomfortable consequence: a new money-surface operation added WITHOUT
 * the decorator silently inherits the WIDE posture.** Declare keywords.
 *
 * ⚠️⚠️ "DO NOT INVENT A KEYWORD HERE" IS STILL THE RULE, BUT CHECKING A SEEDED ONE IS
 * FINE. auth-api's permission tree is real — `features` + `client_features` +
 * `client_feature_roles`, projected flat by `extractAuthInfo` — and the withdrawal
 * keywords are seeded by `1791110351735-SeedWithdrawalReviewFeatures`. What is still
 * missing is the Permission Registry **document** named in CLAUDE.md's authority
 * chain, which governs what keywords *should* exist, not whether the mechanism works.
 * So: keywords that are **seeded and grantable** may be checked here; keywords are
 * still never invented at a call site.
 *
 * ⚠️ `401` vs `403` IS A REAL DISTINCTION HERE, not decoration. A token this key
 * cannot open did not come from our gateway → `401`, re-authenticate. A token that
 * opens but carries no `user` is genuinely ours and simply names no actor → `403`,
 * and re-authenticating would not help. Collapsing them would send an operator to
 * fix the wrong thing — which is precisely what `JwtAuthGuard` did.
 *
 * ⚠️ IT READS THE REQUEST FROM THE **GRAPHQL** CONTEXT. Every consumer builds the
 * context as `{ req }`; `ctx.switchToHttp().getRequest()` under the Apollo driver
 * yields undefined and turns every 401 into a 500.
 *
 * ⚠️⚠️ CONSTRUCTOR PARAMS CARRY AN EXPLICIT `@Inject`, AND THAT IS NOT STYLE — IT IS
 * WHAT MAKES DI WORK FROM A BUNDLED PACKAGE. `gt-shared-lib` is built by tsup, i.e.
 * esbuild, which implements `experimentalDecorators` but **not**
 * `emitDecoratorMetadata`. Without the explicit tokens Nest reads an empty
 * `design:paramtypes` and instantiates this guard with ZERO arguments, so
 * `this.jwtService` is `undefined` and every guarded request throws a 500. The
 * failure appears only at runtime in a consumer, never while building this package.
 */
@Injectable()
export class GatewayStaffGuard implements CanActivate {
    constructor(
        @Inject(JwtService) private readonly jwtService: JwtService,
        @Inject(Reflector) private readonly reflector: Reflector,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const gqlContext = GqlExecutionContext.create(context).getContext<GatewayStaffContext & { req?: unknown }>();
        const req = (gqlContext?.req ?? gqlContext) as
            | {
                  headers?: Record<string, string | string[] | undefined>;
                  gatewayUser?: JwtPayload;
                  user?: JwtPayload;
              }
            | undefined;

        const rawHeader = req?.headers?.["authorization"];
        const authHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            throw new UnauthorizedException("Missing or invalid Authorization header");
        }

        const payload = await this.jwtService.decryptToken(authHeader.slice("Bearer ".length));

        if (!payload?.user?.id) {
            /**
             * ⚠️ THE MESSAGE NAMES NEITHER THE ACTOR NOR THE TOKEN. It is returned to
             * a caller who has already failed the check, and a GraphQL error message
             * travels further than an HTTP status line.
             */
            throw new ForbiddenException("A staff identity is required");
        }

        /**
         * ⚠️ `getAllAndOverride` SO AN OPERATION'S OWN DECLARATION WINS OVER THE
         * CLASS'S. Both the resolver class and each operation carry `@UseGuards`, and
         * an operation may legitimately need a different keyword than its siblings
         * (the policy mutation needs the DIRECTOR keyword, its neighbours do not).
         */
        const required = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRE_PERMISSIONS_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        /**
         * ⚠️⚠️ NO DECLARATION → TODAY'S BEHAVIOUR, UNCHANGED. `providerCredentials`
         * declares nothing and must keep passing on identity alone, and so does every
         * balance-api / segmentation-api operation; see {@link RequirePermissions}.
         * This early return is what makes the adoption additive rather than a breaking
         * change to three services' admin surfaces.
         */
        if (required && required.length > 0) {
            this.assertPermissions(payload, required);
            this.assertTenant(payload, context);
        }

        if (req) {
            req.gatewayUser = payload;
            /**
             * ⚠️⚠️ `req.user` IS NOT A LEGACY ALIAS — IT IS THE SHAPE FIVE LIVE READERS
             * EXPECT, AND DROPPING IT IS THE ONLY WAY THIS EXTRACTION CAN BREAK
             * PRODUCTION. `JwtAuthGuard`, which this guard replaced in balance-api and
             * segmentation-api, attached the payload here. Still reading it:
             *
             *   - `mask-unless-feature.decorator.ts` (segmentation) — reads the NESTED
             *     path `req.user.user.permissions` and masks when it is absent. It fails
             *     CLOSED, so a miss does not leak: it returns `*****` to **everyone**,
             *     including permission holders, and that looks like missing data rather
             *     than an auth bug. This is the worst failure in the set because it is
             *     the quietest.
             *   - `permissions.guard.ts` (segmentation) — same NESTED path; a miss 403s
             *     all of its keyword-gated operations and the symptom points at auth-api.
             *   - `current-user.decorator.ts` (segmentation) — `@CurrentUser()`, the
             *     `me` query's only source.
             *   - `audit/audit-actor.ts` in **both** balance-api and segmentation-api —
             *     a miss writes `actorType: "system"` and a NULL actor onto an audit row
             *     instead of failing, including on balance-api's money-repair path.
             *   - `rest-auth.guard.ts` (segmentation) — sets this itself, for parity.
             *
             * Converging those readers onto `gatewayUser` is a later tidy-up. Until then
             * BOTH fields are set, to the SAME payload object, and specs pin both.
             */
            req.user = payload;
        }

        return true;
    }

    /**
     * ⚠️ FAILS CLOSED. A missing or empty `permissions` array refuses a DECLARED
     * operation — exactly as the shared secret it replaces did. `extractAuthInfo`
     * projects a flat list, so this is a plain membership test and never a tree walk:
     * holding `_DIRECTOR_APPROVE` does not imply `_APPROVE`.
     *
     * ⚠️ EVERY keyword must be held (`every`, not `some`). A declaration is an AND.
     */
    private assertPermissions(payload: JwtPayload, required: string[]): void {
        const held = payload.user?.permissions ?? [];
        const missing = required.filter((keyword) => !held.includes(keyword));
        if (missing.length === 0) return;

        /**
         * ⚠️ IT NAMES THE MISSING KEYWORD AND NOTHING ELSE. The keyword is not a
         * secret — an operator needs it to ask for the right grant — but the actor,
         * their held permissions and the token must not appear in a GraphQL error.
         */
        throw new ForbiddenException(`Missing required permission: ${missing.join(", ")}`);
    }

    /**
     * ⚠️⚠️ THE TENANT CHECK, AND IT IS COUPLED TO THE KEYWORD DECLARATION ON PURPOSE.
     * A permission check without a tenant check on a money surface is worse than
     * neither: it reads as enforcement while letting a holder of `_APPROVE` act on
     * every casino. This is why payment-api's withdrawal surface declares keywords and
     * why the services that already have a RICHER tenant rule declare none.
     *
     * The history: payment-api's deleted `withdrawal-admin.controller.ts` was
     * tenant-scoped by `CasinoAuthGuard`, which derived the casino from the tenant
     * `X-API-Key` and cross-checked it against `:casinoIdentifier`. A staff JWE carries
     * no such check by default, because `casinoIdentifier` is merely a resolver
     * ARGUMENT — so an operator holding `_APPROVE` for one brand could approve every
     * brand's payouts simply by changing it.
     *
     * ⚠️⚠️ IT READS **BOTH** ARGUMENT SHAPES, BECAUSE THAT SURFACE USES BOTH. The
     * queries plus `approveWithdrawal` / `sendWithdrawal` / `reconcileWithdrawal`
     * take `casinoIdentifier` at the TOP LEVEL; `rejectWithdrawal` /
     * `cancelWithdrawal` / `setWithdrawalApprovalSettings` carry it INSIDE `input`
     * (mirroring `UpsertProviderCredentialsInput`). A guard reading only
     * `args.casinoIdentifier` would see `undefined` on those three — so they would
     * either 403 on every legitimate call, or, if a missing value were waved
     * through, become the only UNSCOPED mutations on the surface. Both outcomes are
     * worse than no guard, because both read as enforcement.
     *
     * ⚠️ FAILS CLOSED on an undeterminable tenant and on a token with no
     * `client.identifier` or `client.name`. "Cannot tell which casino" must never mean
     * "allow".
     */
    private assertTenant(payload: JwtPayload, context: ExecutionContext): void {
        const args = GqlExecutionContext.create(context).getArgs<{
            casinoIdentifier?: unknown;
            input?: { casinoIdentifier?: unknown };
        }>();

        const requested = args?.casinoIdentifier ?? args?.input?.casinoIdentifier;
        if (typeof requested !== "string" || requested.length === 0) {
            throw new ForbiddenException("This operation is tenant-scoped and names no casino");
        }

        /**
         * ⚠️⚠️ **`identifier ?? name`, AND READING ONLY `identifier` REFUSED EVERY REAL
         * REQUEST.** The claim this code was written against — "auth-api sends
         * `client.identifier` in every JWE" — is false in the only place that matters: the
         * GATEWAY mints the JWE, and `VALIDATE_TOKEN_QUERY` deliberately does **not**
         * request `identifier`, because a gateway deployed ahead of auth-api would fail
         * `validateToken` outright on an unknown GraphQL field. So every live token carries
         * `name` and no `identifier`.
         *
         * Both fields hold the SAME value — auth-api's `extractAuthInfo` sets
         * `name: user.client?.identifier ?? ""` — so `name` is not a weaker substitute,
         * it is the same datum under the older spelling.
         *
         * 🔴 Observed on demo 2026-10-05: every operator call to `adminWithdrawals` and
         * `withdrawalApprovalSettings` answered `403 This token names no casino`. The guard
         * failed CLOSED, which is the right direction — and it still rejected 100% of real
         * traffic. Failing closed is not the same as being correct.
         *
         * ⚠️ casino-api has read `identifier ?? name` all along. This matches its sibling
         * rather than inventing a stricter contract the producer never agreed to. When the
         * gateway starts requesting `identifier`, this keeps working unchanged.
         */
        const own = payload.client?.identifier ?? payload.client?.name;
        if (typeof own !== "string" || own.length === 0) {
            /**
             * ⚠️ A GENUINE TOKEN THAT NAMES NO TENANT AT ALL — neither spelling. A foreign
             * producer or a drifted gateway; on a money surface the answer to "whose casino
             * is this?" may not be "whichever one you asked for".
             */
            throw new ForbiddenException("This token names no casino");
        }

        if (requested !== own) {
            // ⚠️ NAMES NEITHER IDENTIFIER. Echoing them back confirms to a prober which
            // tenant a token belongs to, and which tenants exist.
            throw new ForbiddenException("This token does not grant access to the requested casino");
        }
    }
}

/**
 * Read the actor a resolver is acting as, once {@link GatewayStaffGuard} has run.
 *
 * ⚠️ IT THROWS RATHER THAN RETURNING `undefined`. A resolver that forgot
 * `@UseGuards(GatewayStaffGuard)` would otherwise get a silent `undefined` and
 * carry on unauthenticated; this makes the omission a loud failure instead of an
 * open endpoint.
 *
 * ⚠️⚠️ IT ACCEPTS **BOTH** CONTEXT SHAPES, AND READING ONLY THE FLAT ONE WAS A REAL
 * BUG THAT SURVIVED BECAUSE THIS FUNCTION HAD ZERO CALLERS. The guard attaches the
 * payload to the REQUEST (`req.gatewayUser`), and every consumer's GraphQL module
 * wraps the request as `{ req }` — so a resolver's `@Context() ctx` carries it at
 * `ctx.req.gatewayUser`. This function used to read `ctx.gatewayUser`, one level
 * too high, which means any resolver calling it would have passed the guard and
 * then thrown `A staff identity is required` on **every** request. Nothing caught
 * it because payment-api's `provider-credentials.resolver.ts` never calls this — it
 * relies on the guard passing and takes its tenant from arguments.
 *
 * The fallback mirrors the guard's own `gqlContext?.req ?? gqlContext`. Keeping the
 * two in step is the actual fix; **do not "simplify" either one to a single shape**,
 * and do not change a consumer's GraphQL context shape to suit this function —
 * `context: ({ req }) => ({ req })` is load-bearing (without it every request becomes
 * a 500 instead of a 401).
 */
export function requireGatewayStaff(context: GatewayStaffContext | undefined): GatewayStaffActor {
    const user = (context?.req?.gatewayUser ?? context?.gatewayUser)?.user;
    if (!user?.id) {
        throw new ForbiddenException("A staff identity is required");
    }
    return {
        id: user.id,
        username: user.username,
        roles: user.roles ?? [],
        permissions: user.permissions ?? [],
    };
}
