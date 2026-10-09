import { defineConfig } from 'tsup';

export default defineConfig({
  // ⚠️⚠️ TWO ENTRIES, AND THE SEPARATION IS THE SECURITY/WEIGHT BOUNDARY.
  // `src/index.ts` is the Kafka SDK — one dependency, `kafkajs`. `src/nest-auth/index.ts`
  // is the shared gateway-identity guard, which needs `@nestjs/*`, `graphql` and `jose`
  // (declared as OPTIONAL peerDependencies). `splitting: false` plus the fact that `.`
  // never imports anything under `nest-auth/` is what makes the runtime guarantee true:
  // `import … from "gt-shared-lib"` executes no NestJS code.
  // ⚠️ `dts: true` MUST emit `dist/nest-auth/index.d.ts` as well as `dist/index.d.ts` —
  // a missing `.d.ts` silently degrades every consumer to `any`, which on an auth
  // boundary is the worst possible outcome. The build script asserts both files exist.
  entry: ['src/index.ts', 'src/nest-auth/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  // Skip cleaning in watch mode: when `npm run dev` runs ybc-shared-lib#build
  // first (turbo dependsOn) and then ybc-shared-lib#dev (--watch), the watch
  // mode would otherwise wipe the freshly-built dist before re-emitting it,
  // leaving downstream tsc --watch consumers (balance-api, etc.) reading
  // empty types for a couple of seconds and caching them incorrectly.
  clean: !process.argv.includes('--watch'),
  splitting: false,
  sourcemap: true,
});
