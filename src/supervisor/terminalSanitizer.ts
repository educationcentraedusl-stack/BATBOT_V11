/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * SOTA 2026 NATIVE AUTONOMOUS PROCESS SUPERVISOR
 * 
 * Terminal State Sanitizer: Restores ANSI terminal state, restores cursor visibility,
 * clears dangling raw-mode attributes, and homes cursor upon worker death or resurrection.
 */

function reportSanitizerNotice(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (process.stderr.writable && !process.stderr.destroyed) {
    process.stderr.write(`[TERMINAL_SANITIZER_WARN] ${context}: ${msg}\n`);
  }
}

/**
 * Unhides cursor and resets graphics rendition mode (colors, bold, underline).
 */
export function resetTerminalAttributes(): void {
  try {
    if (process.stdout.isTTY) {
      // \x1b[?25h -> Show Cursor
      // \x1b[0m   -> Reset Graphics Rendition (Colors/Styles)
      process.stdout.write("\x1b[?25h\x1b[0m");
    }
  } catch (err: unknown) {
    reportSanitizerNotice("resetAttributes", err);
  }
}

/**
 * Resets styling, clears the terminal screen buffer, and homes the cursor to (0,0).
 */
export function clearAndHomeTerminal(): void {
  try {
    if (process.stdout.isTTY) {
      // \x1b[?25h -> Show Cursor
      // \x1b[0m   -> Reset Styling
      // \x1b[2J   -> Clear Entire Screen
      // \x1b[H    -> Move Cursor to Row 1, Column 1
      process.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H");
    }
  } catch (err: unknown) {
    reportSanitizerNotice("clearAndHome", err);
  }
}

/**
 * Restores normal raw-mode input state on process.stdin if it was left hijacked.
 */
export function restoreTerminalStdin(): void {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  } catch (err: unknown) {
    reportSanitizerNotice("restoreStdin", err);
  }
}

/**
 * Performs full deterministic sanitization sweep before spawning a resurrected generation.
 */
export function performFullTerminalSanitization(emitNotice: boolean = true): void {
  restoreTerminalStdin();
  resetTerminalAttributes();
  if (emitNotice) {
    try {
      process.stdout.write(
        "\n\x1b[36m[TERMINAL_SANITIZER]\x1b[0m Terminal state decontaminated. ANSI cursor restored.\n"
      );
    } catch (err: unknown) {
      reportSanitizerNotice("performFullSanitization", err);
    }
  }
}

export const TerminalSanitizer = {
  resetAttributes: resetTerminalAttributes,
  clearAndHome: clearAndHomeTerminal,
  restoreStdin: restoreTerminalStdin,
  performFullSanitization: performFullTerminalSanitization,
} as const;

