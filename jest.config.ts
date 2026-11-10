import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  setupFiles: ["<rootDir>/tests/helpers/jestSetup.cjs"],
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.{ts,tsx}"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.jest.json",
        diagnostics: {
          ignoreCodes: [1343],
        },
        astTransformers: {
          before: ["<rootDir>/tests/helpers/importMetaTransformer.cjs"],
        },
      },
    ],
  },
  clearMocks: true,
  verbose: true,
};

export default config;
