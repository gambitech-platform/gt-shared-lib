/**
 * `gt-shared-lib/nest-auth` — the platform's single gateway-identity floor.
 *
 * ⚠️⚠️ THIS IS A **SECOND ENTRY POINT**, AND THE SPLIT IS THE WHOLE DESIGN. The
 * package's main entry (`gt-shared-lib`) is a Kafka SDK with exactly one dependency,
 * `kafkajs`. This entry needs `@nestjs/common`, `@nestjs/core`, `@nestjs/graphql`,
 * `graphql` and `jose`. Those are declared as **optional peerDependencies**, and the
 * guarantee that holds is a RUNTIME one: `import … from "gt-shared-lib"` executes no
 * NestJS code, because tsup emits the two entries as separate bundles and `.` never
 * reaches into `nest-auth`.
 *
 * ⚠️ IT IS NOT AN INSTALL-GRAPH GUARANTEE. npm 7+ AUTO-INSTALLS plain peers, and a
 * peer range applies to the WHOLE package rather than to one subpath — which is why
 * every peer here is additionally marked `"optional": true` under
 * `peerDependenciesMeta`. The cost of that flag is the thing to remember: a consumer
 * that imports this entry gets **no** automatic resolution, so it must declare
 * `@nestjs/*`, `graphql` and `jose` itself. It may *appear* to work via workspace
 * hoisting from a sibling that has them; do not trust that.
 */
export { GatewayStaffGuard, RequirePermissions, REQUIRE_PERMISSIONS_KEY, requireGatewayStaff } from "./gateway-staff.guard";
export { JwtService, JWT_ENCRYPTION_KEY } from "./jwt.service";
export type { JwtPayload, GatewayStaffActor, GatewayStaffContext } from "./types";
