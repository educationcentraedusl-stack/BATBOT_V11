// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const DASHBOARD_BROWSER_FILES = ["src/dashboard/**/*.{ts,tsx}", "src/lib/**/*.ts"];
const DASHBOARD_BROWSER_IGNORES = ["src/dashboard/telemetry.worker.ts", "src/dashboard/telemetry.types.ts"];
const WORKER_FILES = ["src/dashboard/telemetry.worker.ts", "src/dashboard/telemetry.types.ts"];
const ISOMORPHIC_PROTO_FILES = ["src/telemetry/proto.ts", "src/telemetry/types.ts"];
const VITE_NODE_CONFIG_FILES = ["vite.config.ts"];
const BACKEND_NODE_FILES = ["src/**/*.ts"];
const BACKEND_NODE_IGNORES = [
  "src/dashboard/**",
  "src/lib/**",
  "src/telemetry/proto.ts",
  "src/telemetry/types.ts",
];
const STANDALONE_NODE_TEST_FILES = ["tests/verify_killswitch_hotswap.ts", "jest.config.ts"];
const JEST_DOM_TEST_FILES = ["tests/**/*.test.{ts,tsx}"];

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

/**
 * @param {string[]} files
 * @param {string[]} [ignores]
 */
function scopedStrictTypeChecked(files, ignores = []) {
  return tseslint.configs.strictTypeChecked.map((cfg) => ({
    ...cfg,
    files,
    ...(ignores.length > 0 ? { ignores } : {}),
  }));
}

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
      // Frozen core strategy and deferred legacy standalone test scripts:
      "src/strategy/**",
      "src/tests/**",
      "src/test_*.ts",
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
  {
    files: ["tests/helpers/**/*.cjs"],
    ...js.configs.recommended,
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
  },
  // 1. Browser React Dashboard (Browser globals ONLY — zero Node globals)
  ...scopedStrictTypeChecked(DASHBOARD_BROWSER_FILES, DASHBOARD_BROWSER_IGNORES),
  {
    files: DASHBOARD_BROWSER_FILES,
    ignores: DASHBOARD_BROWSER_IGNORES,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.dashboard.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...STRICT_GOVERNANCE_RULES,
    },
  },
  {
    files: ["src/dashboard/**/*.{ts,tsx}"],
    ignores: DASHBOARD_BROWSER_IGNORES,
    ...reactHooks.configs.flat.recommended,
  },
  // 2. WebWorker (Worker globals ONLY — zero DOM/Browser or Node globals)
  ...scopedStrictTypeChecked(WORKER_FILES),
  {
    files: WORKER_FILES,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.worker.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.worker,
      },
    },
    rules: {
      ...STRICT_GOVERNANCE_RULES,
    },
  },
  // 3. Isomorphic Protobuf Layer (pure ES2022 — zero DOM or Node globals)
  ...scopedStrictTypeChecked(ISOMORPHIC_PROTO_FILES),
  {
    files: ISOMORPHIC_PROTO_FILES,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.worker.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {},
    },
    rules: {
      ...STRICT_GOVERNANCE_RULES,
    },
  },
  // 4. Vite Build Configuration (Node globals ONLY)
  ...scopedStrictTypeChecked(VITE_NODE_CONFIG_FILES),
  {
    files: VITE_NODE_CONFIG_FILES,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...STRICT_GOVERNANCE_RULES,
    },
  },
  // 5. Node Backend Modules (Node globals ONLY — zero Browser or Worker globals)
  ...scopedStrictTypeChecked(BACKEND_NODE_FILES, BACKEND_NODE_IGNORES),
  {
    files: BACKEND_NODE_FILES,
    ignores: BACKEND_NODE_IGNORES,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...STRICT_GOVERNANCE_RULES,
    },
  },
  // 6. Standalone Node Scripts & Jest Configuration (Node globals ONLY)
  ...scopedStrictTypeChecked(STANDALONE_NODE_TEST_FILES),
  {
    files: STANDALONE_NODE_TEST_FILES,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.jest.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...STRICT_GOVERNANCE_RULES,
    },
  },
  // 7. Jest JSDOM Component & Governance Test Suites
  ...scopedStrictTypeChecked(JEST_DOM_TEST_FILES),
  {
    files: JEST_DOM_TEST_FILES,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.jest.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.jest,
        ...globals.browser,
      },
    },
    rules: {
      ...STRICT_GOVERNANCE_RULES,
    },
  }
);
