// ESLint flat config for ybc-shared-lib.
//
// Mirrors apps/ybc-balance-api/eslint.config.mjs: `@eslint/js` recommended +
// `typescript-eslint` recommended + `eslint-config-prettier` last (the latter
// only TURNS RULES OFF — it never formats). `eslint-plugin-prettier` is
// deliberately NOT enabled: formatting stays a `prettier` concern, so a lint
// run never rewrites whitespace.
//
// Flat format is correct here because this workspace has no eslint pin of its
// own and therefore resolves the root-hoisted toolchain (eslint 9 +
// typescript-eslint 8), which is flat-native. Like balance-api, the imports
// below resolve from the monorepo root `node_modules` rather than a local
// install — lint only ever runs from a full root workspace install (turbo
// `lint`), never inside a Docker image, so no lockfile churn is needed.
//
// Type-aware linting (`recommendedTypeChecked`) is intentionally off: it needs
// a tsconfig project per lint run and is far slower for no benefit at this
// rule level.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
    { ignores: ["dist/**", "coverage/**", "node_modules/**", "*.config.mjs", "*.config.ts"] },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    eslintConfigPrettier,
    {
        languageOptions: {
            globals: { ...globals.node },
            sourceType: "module",
            parserOptions: { ecmaVersion: "latest" },
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
            ],
            "@typescript-eslint/no-empty-object-type": "off",
        },
    },
    {
        files: ["tests/**/*.ts", "examples/**/*.ts", "**/*.spec.ts", "**/*.test.ts"],
        rules: {
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unused-expressions": "off",
        },
    },
);
