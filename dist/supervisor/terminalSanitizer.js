"use strict";
/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * SOTA 2026 NATIVE AUTONOMOUS PROCESS SUPERVISOR
 *
 * Terminal State Sanitizer: Restores ANSI terminal state, restores cursor visibility,
 * clears dangling raw-mode attributes, and homes cursor upon worker death or resurrection.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalSanitizer = void 0;
exports.resetTerminalAttributes = resetTerminalAttributes;
exports.clearAndHomeTerminal = clearAndHomeTerminal;
exports.restoreTerminalStdin = restoreTerminalStdin;
exports.performFullTerminalSanitization = performFullTerminalSanitization;
function reportSanitizerNotice(context, err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.stderr.writable && !process.stderr.destroyed) {
        process.stderr.write(`[TERMINAL_SANITIZER_WARN] ${context}: ${msg}\n`);
    }
}
/**
 * Unhides cursor and resets graphics rendition mode (colors, bold, underline).
 */
function resetTerminalAttributes() {
    try {
        if (process.stdout.isTTY) {
            // \x1b[?25h -> Show Cursor
            // \x1b[0m   -> Reset Graphics Rendition (Colors/Styles)
            process.stdout.write("\x1b[?25h\x1b[0m");
        }
    }
    catch (err) {
        reportSanitizerNotice("resetAttributes", err);
    }
}
/**
 * Resets styling, clears the terminal screen buffer, and homes the cursor to (0,0).
 */
function clearAndHomeTerminal() {
    try {
        if (process.stdout.isTTY) {
            // \x1b[?25h -> Show Cursor
            // \x1b[0m   -> Reset Styling
            // \x1b[2J   -> Clear Entire Screen
            // \x1b[H    -> Move Cursor to Row 1, Column 1
            process.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H");
        }
    }
    catch (err) {
        reportSanitizerNotice("clearAndHome", err);
    }
}
/**
 * Restores normal raw-mode input state on process.stdin if it was left hijacked.
 */
function restoreTerminalStdin() {
    try {
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
            process.stdin.setRawMode(false);
            process.stdin.pause();
        }
    }
    catch (err) {
        reportSanitizerNotice("restoreStdin", err);
    }
}
/**
 * Performs full deterministic sanitization sweep before spawning a resurrected generation.
 */
function performFullTerminalSanitization(emitNotice = true) {
    restoreTerminalStdin();
    resetTerminalAttributes();
    if (emitNotice) {
        try {
            process.stdout.write("\n\x1b[36m[TERMINAL_SANITIZER]\x1b[0m Terminal state decontaminated. ANSI cursor restored.\n");
        }
        catch (err) {
            reportSanitizerNotice("performFullSanitization", err);
        }
    }
}
exports.TerminalSanitizer = {
    resetAttributes: resetTerminalAttributes,
    clearAndHome: clearAndHomeTerminal,
    restoreStdin: restoreTerminalStdin,
    performFullSanitization: performFullTerminalSanitization,
};
