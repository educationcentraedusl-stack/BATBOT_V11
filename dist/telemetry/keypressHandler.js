"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InteractiveKeypressEngine = void 0;
class InteractiveKeypressEngine {
    client;
    isListening = false;
    onAssetFocusChange;
    onNotification;
    rawModePreviousState = false;
    constructor(client) {
        this.client = client;
    }
    /**
     * Registers callback for switching focused asset index slot in TUI Dashboard.
     */
    setAssetFocusCallback(cb) {
        this.onAssetFocusChange = cb;
    }
    /**
     * Registers callback for logging notification feedback in TUI Dashboard.
     */
    setNotificationCallback(cb) {
        this.onNotification = cb;
    }
    /**
     * Starts capturing raw terminal keypress events and writing atomic control flags to SAB.
     */
    start() {
        if (this.isListening)
            return;
        if (process.stdin.isTTY) {
            this.rawModePreviousState = process.stdin.isRaw ?? false;
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", this.handleKeyPress);
            this.isListening = true;
            this.notify("[KEYBOARD_ENGINE] Sub-millisecond raw keypress capture active. Press 'K' for Kill, 'C' for Close All, 'P' for Pause, 0-9 for Asset Focus.");
        }
        else {
            this.notify("[KEYBOARD_ENGINE] Non-TTY environment detected. Keypress input monitoring disabled.");
        }
    }
    /**
     * Raw keypress event handler operating synchronously with zero async promise overhead.
     */
    handleKeyPress = (data) => {
        const key = data.toString();
        // Intercept Ctrl+C (0x03) or Q/q for graceful shutdown
        if (key === "\u0003" || key === "q" || key === "Q") {
            this.notify("[KEYBOARD_ENGINE] Graceful shutdown requested via terminal keypress.");
            this.stop();
            process.exit(0);
        }
        // Emergency Kill Switch ('K' / 'k')
        if (key === "k" || key === "K") {
            const currentState = this.client.getKillSwitchFlag(0);
            const newState = !currentState;
            this.client.setGlobalKillSwitch(newState);
            this.notify(newState
                ? "🚨 [EMERGENCY KILL SWITCH ACTIVATED] Atomic SAB flag set to KILLED. Rust OMS execution halted."
                : "🟢 [EMERGENCY KILL SWITCH CLEARED] Engine execution restored.");
            return;
        }
        // Panic Close All Positions ('C' / 'c')
        if (key === "c" || key === "C") {
            this.client.setGlobalCloseAll(true);
            this.notify("⚠️ [PANIC CLOSE ALL POSITIONS] Atomic SAB flag set. Dispatched market exit across all asset slots.");
            return;
        }
        // Toggle Engine Pause / Resume ('P' / 'p')
        if (key === "p" || key === "P") {
            const isPaused = this.client.getEnginePausedFlag(0);
            const nextPaused = !isPaused;
            this.client.setGlobalPause(nextPaused);
            this.notify(nextPaused
                ? "⏸️ [STRATEGY PAUSED] Atomic SAB engine pause flag active."
                : "▶️ [STRATEGY RESUMED] Engine pause flag cleared.");
            return;
        }
        // Trigger Model Recalibration ('R' / 'r')
        if (key === "r" || key === "R") {
            this.client.setGlobalRecalibration(true);
            this.notify("🔄 [MODEL RECALIBRATION] Manual trigger flag dispatched to AI engine.");
            return;
        }
        // Direct Asset Index Selection ('0' - '9')
        if (key >= "0" && key <= "9") {
            const idx = parseInt(key, 10);
            if (idx < this.client.maxAssets) {
                if (this.onAssetFocusChange) {
                    this.onAssetFocusChange(idx);
                }
                this.notify(`🔍 [ASSET FOCUS] Switched focused view to Asset Slot #${idx}.`);
            }
            else {
                this.notify(`⚠️ [ASSET FOCUS] Asset Slot #${idx} out of bounds (Max: ${this.client.maxAssets - 1}).`);
            }
            return;
        }
    };
    /**
     * Emits notification message to registered TUI event log callback.
     */
    notify(message) {
        if (this.onNotification) {
            this.onNotification(message);
        }
    }
    /**
     * Restores terminal stdin raw mode and detaches listener.
     */
    stop() {
        if (!this.isListening)
            return;
        if (process.stdin.isTTY) {
            process.stdin.removeListener("data", this.handleKeyPress);
            process.stdin.setRawMode(this.rawModePreviousState);
            process.stdin.pause();
        }
        this.isListening = false;
    }
}
exports.InteractiveKeypressEngine = InteractiveKeypressEngine;
