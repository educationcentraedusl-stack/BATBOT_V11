import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, domAnimation } from "framer-motion";
import { initTelemetryWorker } from "@/dashboard/store";
import { App } from "@/dashboard/App";
import { ControlCenter } from "@/dashboard/components/ControlCenter";
import { ExecutionView } from "@/dashboard/components/ExecutionView";
import { ErrorBoundary } from "@/dashboard/components/ErrorBoundary";
import type { TelemetryWorkerOutboundMessage, WorkerFrameData } from "@/dashboard/telemetry.types";
import { cn } from "@/lib/utils";

interface RecordedWorkerMessage {
  type?: string;
  url?: string;
  command?: {
    action: string;
    modelPath?: string;
    timestamp?: number;
  };
}

class MockTelemetryWorker {
  public static instances: MockTelemetryWorker[] = [];
  public readonly scriptURL: string | URL;
  public readonly postedMessages: RecordedWorkerMessage[] = [];
  public onmessage: ((ev: MessageEvent<TelemetryWorkerOutboundMessage>) => void) | null = null;
  public onerror: ((ev: ErrorEvent) => void) | null = null;
  public terminated = false;

  public constructor(scriptURL: string | URL) {
    this.scriptURL = scriptURL;
    MockTelemetryWorker.instances.push(this);
  }

  public postMessage(message: RecordedWorkerMessage): void {
    this.postedMessages.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public dispatchInbound(payload: TelemetryWorkerOutboundMessage): void {
    if (this.onmessage) {
      const event = new MessageEvent<TelemetryWorkerOutboundMessage>("message", { data: payload });
      this.onmessage(event);
    }
  }
}

class MockResizeObserver implements ResizeObserver {
  public observe(): void {
    // Container sizes remain 0x0 in JSDOM unless explicitly triggered
  }

  public unobserve(): void {
    // No-op in JSDOM environment
  }

  public disconnect(): void {
    // No-op in JSDOM environment
  }
}

function makeSampleFrame(overrides: Partial<WorkerFrameData> = {}): WorkerFrameData {
  return {
    timestamp: 1_762_000_000_000,
    sequenceNum: "42",
    symbol: "BTCUSDT",
    isEngineActive: true,
    aiDirection: 0.42,
    aiConfidence: 0.85,
    aiInferenceLatencyNs: "1200",
    rollingIc: 0.0812,
    latencyPenalty: 1.0,
    slippageTicks: 2,
    tickEvaluationLatencyUs: 1.45,
    rttMs: 12.3,
    usdtBalance: 1000,
    obi: 0.5,
    cvd: 12.5,
    spreadVelocity: 0.0001,
    bidPrice: 95000,
    askPrice: 95001,
    riskStatus: "PASSED",
    lastSignal: "BUY",
    stats: {
      positionSide: "LONG",
      netQuantity: 0.01,
      averageEntryPrice: 94800,
      realizedPnl: 42.5,
      unrealizedPnl: 12.25,
      winRatePercent: 66.7,
      totalTrades: 9,
      winningTrades: 6,
      losingTrades: 3,
      totalSignalsLogged: 120,
      totalExecutionsLogged: 1,
      totalFees: 0.4,
      avgTickLatencyUs: 1.45,
      bufferQueueDepth: 0,
    },
    ...overrides,
  };
}

let consoleErrorSpy: jest.SpiedFunction<typeof console.error> | null = null;
const originalWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalResizeObserverDesc = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
const originalMatchMediaDesc = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalRafDesc = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
const originalCancelRafDesc = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");

let rafCounter = 1;
const activeRafTimers = new Map<number, ReturnType<typeof setTimeout>>();

function restoreGlobalProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: MockTelemetryWorker,
  });

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: MockResizeObserver,
  });

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
      dispatchEvent: (): boolean => false,
    }),
  });

  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback): number => {
      const id = rafCounter++;
      const timer = setTimeout(() => {
        activeRafTimers.delete(id);
        callback(performance.now());
      }, 16);
      activeRafTimers.set(id, timer);
      return id;
    },
  });

  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: (id: number): void => {
      const timer = activeRafTimers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        activeRafTimers.delete(id);
      }
    },
  });

  if (typeof Element !== "undefined") {
    Element.prototype.hasPointerCapture = (): boolean => false;
    Element.prototype.setPointerCapture = (): void => undefined;
    Element.prototype.releasePointerCapture = (): void => undefined;
    Element.prototype.scrollIntoView = (): void => undefined;
  }
});

afterAll(() => {
  for (const timer of activeRafTimers.values()) {
    clearTimeout(timer);
  }
  activeRafTimers.clear();

  restoreGlobalProperty(globalThis, "Worker", originalWorkerDesc);
  restoreGlobalProperty(globalThis, "ResizeObserver", originalResizeObserverDesc);
  restoreGlobalProperty(window, "matchMedia", originalMatchMediaDesc);
  restoreGlobalProperty(globalThis, "requestAnimationFrame", originalRafDesc);
  restoreGlobalProperty(globalThis, "cancelAnimationFrame", originalCancelRafDesc);
});

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  for (const timer of activeRafTimers.values()) {
    clearTimeout(timer);
  }
  activeRafTimers.clear();
  consoleErrorSpy?.mockRestore();
  consoleErrorSpy = null;
});

describe("Phase 0 Tooling & Shadcn/Framer Governance (Real JSDOM Rendering)", () => {
  it("renders full <App /> with LazyMotion strict mode, 3-column command layout, and telemetry worker", () => {
    render(React.createElement(App));

    expect(screen.getByText(/BATBOT_V11/i)).toBeTruthy();
    expect(screen.getByText(/ENGINE GOVERNANCE & CONTROL/i)).toBeTruthy();
    expect(screen.getByText(/AI TELEMETRY & SHADOW INSPECTOR/i)).toBeTruthy();
    expect(screen.getByText(/EXECUTION, INVENTORY & PnL LEDGER/i)).toBeTruthy();
    expect(screen.getByText("DISCONNECTED")).toBeTruthy();

    expect(MockTelemetryWorker.instances.length).toBeGreaterThanOrEqual(1);
    const worker = MockTelemetryWorker.instances.at(0);
    expect(worker).toBeDefined();
    if (!worker) throw new Error("Telemetry worker not initialized");
    expect(String(worker.scriptURL)).toContain("telemetry.worker.ts");
    expect(worker.postedMessages.at(0)).toEqual({
      type: "CONNECT",
      url: "ws://localhost:8080",
    });
  });

  it("renders <ControlCenter /> using Shadcn Button + Select (no native <select>) and dispatches RPC commands", () => {
    const { container } = render(
      React.createElement(
        LazyMotion,
        { features: domAnimation, strict: true },
        React.createElement(ControlCenter)
      )
    );

    expect(container.querySelector("select")).toBeNull();

    const trigger = screen.getByRole("combobox", { name: "AI Model Weights Selector" });
    expect(trigger.getAttribute("data-slot")).toBe("select-trigger");

    const startBtn = screen.getByRole("button", { name: /START HFT ENGINE/i });
    expect(startBtn.getAttribute("data-slot")).toBe("button");

    initTelemetryWorker("ws://localhost:8080");
    const worker = MockTelemetryWorker.instances.at(0);
    expect(worker).toBeDefined();
    if (!worker) throw new Error("Telemetry worker not initialized");
    const countBeforeStart = worker.postedMessages.length;

    fireEvent.click(startBtn);
    expect(screen.getByText(/Requested ENGINE_START/i)).toBeTruthy();
    expect(worker.postedMessages.length).toBe(countBeforeStart + 1);
    expect(worker.postedMessages.at(countBeforeStart)?.command?.action).toBe("ENGINE_START");

    fireEvent.click(trigger);
    const cfcOption = screen.getByRole("option", { name: /cfc_hft_model\.safetensors/i });
    fireEvent.click(cfcOption);

    const hotSwapBtn = screen.getByRole("button", { name: /EXECUTE HOT-SWAP/i });
    fireEvent.click(hotSwapBtn);
    expect(screen.getByText(/Triggered Hot-Swap for models\/cfc_hft_model\.safetensors/i)).toBeTruthy();

    const lastMsg = worker.postedMessages.at(-1);
    expect(lastMsg?.type).toBe("SEND_COMMAND");
    expect(lastMsg?.command?.action).toBe("AI_HOT_SWAP");
    expect(lastMsg?.command?.modelPath).toBe("models/cfc_hft_model.safetensors");
  });

  it("renders Emergency Kill Switch confirmation via Framer Motion m.div + AnimatePresence under LazyMotion strict", async () => {
    render(
      React.createElement(
        LazyMotion,
        { features: domAnimation, strict: true },
        React.createElement(ControlCenter)
      )
    );

    const killBtn = screen.getByRole("button", { name: /EMERGENCY KILL SWITCH/i });
    fireEvent.click(killBtn);

    expect(screen.getByText(/EMERGENCY KILL SWITCH CONFIRMATION/i)).toBeTruthy();
    const cancelBtn = screen.getByRole("button", { name: "CANCEL" });
    expect(cancelBtn.getAttribute("data-slot")).toBe("button");

    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(screen.queryByText(/EMERGENCY KILL SWITCH CONFIRMATION/i)).toBeNull();
    });

    fireEvent.click(killBtn);
    const confirmBtn = screen.getByRole("button", { name: /CONFIRM KILL & FLATTEN/i });
    expect(confirmBtn.getAttribute("data-slot")).toBe("button");
    fireEvent.click(confirmBtn);

    expect(screen.getByText(/EMERGENCY KILL SWITCH TRIGGERED!/i)).toBeTruthy();
    const worker = MockTelemetryWorker.instances.at(0);
    if (!worker) throw new Error("Telemetry worker not initialized");
    const lastMsg = worker.postedMessages.at(-1);
    expect(lastMsg?.command?.action).toBe("EMERGENCY_KILL");
  });

  it("renders <ExecutionView /> without CSS transition classes on OBI bars (Rule 5) and mutates refs on RAF frame", async () => {
    const { container } = render(React.createElement(ExecutionView));

    const greenBar = container.querySelector(".bg-emerald-500.h-full");
    const redBar = container.querySelector(".bg-rose-500.h-full");

    expect(greenBar).not.toBeNull();
    expect(redBar).not.toBeNull();
    expect(greenBar?.className).not.toContain("transition-all");
    expect(greenBar?.className).not.toContain("duration-100");
    expect(redBar?.className).not.toContain("transition-all");
    expect(redBar?.className).not.toContain("duration-100");

    initTelemetryWorker("ws://localhost:8080");
    const worker = MockTelemetryWorker.instances.at(0);
    if (!worker) throw new Error("Telemetry worker not initialized");

    await act(async () => {
      worker.dispatchInbound({
        type: "FRAME_BATCH",
        frame: makeSampleFrame(),
        recentCount: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(greenBar instanceof HTMLElement ? greenBar.style.width : "").toBe("75%");
    expect(redBar instanceof HTMLElement ? redBar.style.width : "").toBe("25%");
    expect(screen.getByText("+0.5000")).toBeTruthy();
    expect(screen.getByText("$42.50")).toBeTruthy();
  });

  it("renders Shadcn <Button> inside <ErrorBoundary /> and recovers child component on click", () => {
    let shouldThrow = true;

    const FaultyPanel: React.FC = () => {
      if (shouldThrow) {
        throw new Error("Simulated render fault");
      }
      return React.createElement("div", null, "RECOVERED_PANEL_CONTENT");
    };

    render(
      React.createElement(ErrorBoundary, {
        title: "AI TELEMETRY",
        children: React.createElement(FaultyPanel),
      })
    );

    expect(screen.getByText(/AI TELEMETRY RECOVERY ISOLATION/i)).toBeTruthy();
    expect(screen.getByText("Simulated render fault")).toBeTruthy();

    const restartBtn = screen.getByRole("button", { name: /RESTART PANEL/i });
    expect(restartBtn.getAttribute("data-slot")).toBe("button");

    shouldThrow = false;
    fireEvent.click(restartBtn);
    expect(screen.getByText("RECOVERED_PANEL_CONTENT")).toBeTruthy();
  });

  it("merges conflicting Tailwind utility classes cleanly via Shadcn cn()", () => {
    const merged = cn("px-2 py-1 bg-slate-900 text-xs", "px-4 bg-slate-950");
    expect(merged).toContain("px-4");
    expect(merged).toContain("bg-slate-950");
    expect(merged).not.toContain("px-2");
    expect(merged).not.toContain("bg-slate-900");
  });
});
