// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const PHASE0_TS_SCOPE = ["src/dashboard/**/*.{ts,tsx}", "src/lib/**/*.ts", "vite.config.ts"];
const PHASE0_TEST_SCOPE = ["tests/**/*.test.ts", "jest.config.ts"];
const STRICT_GOVERNANCE_RULES = /** @type {const} */ ({
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
  "no-empty": "error",
});

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "target/**",
      "node_modules/**",
      "training/**",
      "index.js",
      "index.d.ts",
      "ecosystem.config.js",
      "update_csv.js",
      "scripts/**",
      // Phase 0 constraint: Core strategy, execution, telemetry, and legacy test scripts
      // remain frozen during Phase 0 setup and are progressively onboarded in P0-T2 / Phases 1-6.
      "src/ai/**",
      "src/backtest/**",
      "src/config/**",
      "src/execution/**",
      "src/ipc/**",
      "src/lob/**",
      "src/oms/**",
      "src/risk/**",
      "src/scripts/**",
      "src/strategy/**",
      "src/supervisor/**",
      "src/telemetry/**",
      "src/tests/**",
      "src/utils/**",
      "src/index.ts",
      "src/marketDataClient.ts",
      "src/test_*.ts",
      "tests/verify_killswitch_hotswap.ts",
    ],
  },
  {
    files: ["eslint.config.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  ...tseslint.configs.strictTypeChecked.map((cfg) => ({
    ...cfg,
    files: PHASE0_TS_SCOPE,
  })),
  {
    files: PHASE0_TS_SCOPE,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.dashboard.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      ...STRICT_GOVERNANCE_RULES,
    },
  },
  {
    files: ["src/dashboard/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat.recommended,
  },
  ...tseslint.configs.strictTypeChecked.map((cfg) => ({
    ...cfg,
    files: PHASE0_TEST_SCOPE,
  })),
  {
    files: PHASE0_TEST_SCOPE,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.jest.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      ...STRICT_GOVERNANCE_RULES,
    },
  }
);
