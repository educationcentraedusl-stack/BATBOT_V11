import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "@jest/globals";
import { cn } from "../src/lib/utils";

const ROOT_DIR = path.resolve(__dirname, "..");

interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ComponentsJsonShape {
  style?: string;
  rsc?: boolean;
  tsx?: boolean;
  tailwind?: {
    config?: string;
    css?: string;
    baseColor?: string;
    cssVariables?: boolean;
  };
  aliases?: Record<string, string>;
}

describe("Phase 0: Governance, Strict Tooling & Tailwind v4 CSS Modernization", () => {
  it("resolves conflicting Tailwind utility classes cleanly via Shadcn cn()", () => {
    const merged = cn("px-2 py-1 bg-slate-900 text-xs", "px-4 bg-slate-950");
    expect(merged).toContain("px-4");
    expect(merged).toContain("bg-slate-950");
    expect(merged).not.toContain("px-2");
    expect(merged).not.toContain("bg-slate-900");
  });

  it("enforces mandatory Phase 0 packages and real Jest/ESLint scripts in package.json", () => {
    const pkgRaw = fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as PackageJsonShape;

    expect(pkg.dependencies?.["framer-motion"]).toBeDefined();
    expect(pkg.dependencies?.["clsx"]).toBeDefined();
    expect(pkg.dependencies?.["tailwind-merge"]).toBeDefined();
    expect(pkg.dependencies?.["class-variance-authority"]).toBeDefined();

    expect(pkg.devDependencies?.["eslint"]).toMatch(/^\^?9\./);
    expect(pkg.devDependencies?.["jest"]).toMatch(/^\^?30\./);
    expect(pkg.devDependencies?.["typescript-eslint"]).toBeDefined();
    expect(pkg.devDependencies?.["ts-jest"]).toBeDefined();
    expect(pkg.devDependencies?.["tw-animate-css"]).toBeDefined();

    expect(pkg.scripts?.["lint"]).toContain("eslint");
    expect(pkg.scripts?.["typecheck"]).toContain("tsc");
    expect(pkg.scripts?.["test"]).toContain("jest");
    expect(pkg.scripts?.["test"]).not.toBe("tsc --noEmit");
  });

  it("configures Shadcn/UI components.json for Vite + Tailwind v4 with existing targets", () => {
    const raw = fs.readFileSync(path.join(ROOT_DIR, "components.json"), "utf8");
    const cfg = JSON.parse(raw) as ComponentsJsonShape;

    expect(cfg.rsc).toBe(false);
    expect(cfg.tsx).toBe(true);
    expect(cfg.tailwind?.config).toBe("");
    expect(cfg.tailwind?.css).toBe("src/dashboard/index.css");
    expect(cfg.tailwind?.cssVariables).toBe(true);
    expect(fs.existsSync(path.join(ROOT_DIR, cfg.tailwind?.css ?? ""))).toBe(true);
  });

  it("replaces legacy plain CSS rules in index.css with Tailwind v4 @utility and @layer base", () => {
    const css = fs.readFileSync(path.join(ROOT_DIR, "src/dashboard/index.css"), "utf8");

    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain('@import "tw-animate-css";');
    expect(css).toContain("@theme inline");
    expect(css).toContain("@utility uplot-financial");
    expect(css).toContain("@utility scrollbar-financial");

    // Plain CSS top-level selectors must not exist outside Tailwind v4 directives
    expect(css).not.toMatch(/^\s*\.uplot\s*\{/m);
    expect(css).not.toMatch(/^\s*::-webkit-scrollbar\s*\{/m);
  });

  it("uses LazyMotion + m modal transitions without high-frequency price animations", () => {
    const appSrc = fs.readFileSync(path.join(ROOT_DIR, "src/dashboard/App.tsx"), "utf8");
    const ctrlSrc = fs.readFileSync(path.join(ROOT_DIR, "src/dashboard/components/ControlCenter.tsx"), "utf8");
    const execSrc = fs.readFileSync(path.join(ROOT_DIR, "src/dashboard/components/ExecutionView.tsx"), "utf8");

    expect(appSrc).toContain("LazyMotion");
    expect(appSrc).toContain("domAnimation");
    expect(ctrlSrc).toContain("AnimatePresence");
    expect(ctrlSrc).toContain("m.div");
    expect(ctrlSrc).not.toContain("motion.");
    expect(execSrc).not.toContain("framer-motion");
  });

  it("configures ESLint 9 flat config with strictTypeChecked and explicit no-explicit-any governance", () => {
    const eslintCfg = fs.readFileSync(path.join(ROOT_DIR, "eslint.config.mjs"), "utf8");

    expect(eslintCfg).toContain("strictTypeChecked");
    expect(eslintCfg).toContain('"@typescript-eslint/no-explicit-any": "error"');
    expect(eslintCfg).toContain('"@typescript-eslint/no-floating-promises": "error"');
    expect(eslintCfg).toContain("eslint-plugin-react-hooks");
  });
});

