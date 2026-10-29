/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * SOTA 2026 NATIVE AUTONOMOUS PROCESS SUPERVISOR
 * 
 * Terminal State Sanitizer: Restores ANSI terminal state, restores cursor visibility,
 * clears dangling raw-mode attributes, and homes cursor upon worker death or resurrection.
 */

export class TerminalSanitizer {
  /**
   * Unhides cursor and resets graphics rendition mode (colors, bold, underline).
   */
  public static resetAttributes(): void {
    try {
      if (process.stdout.isTTY) {
        // \x1b[?25h -> Show Cursor
        // \x1b[0m   -> Reset Graphics Rendition (Colors/Styles)
        process.stdout.write("\x1b[?25h\x1b[0m");
      }
    } catch {
      // Safe no-op if stdout is closed or detached
    }
  }

  /**
   * Resets styling, clears the terminal screen buffer, and homes the cursor to (0,0).
   */
  public static clearAndHome(): void {
    try {
      if (process.stdout.isTTY) {
        // \x1b[?25h -> Show Cursor
        // \x1b[0m   -> Reset Styling
        // \x1b[2J   -> Clear Entire Screen
        // \x1b[H    -> Move Cursor to Row 1, Column 1
        process.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H");
      }
    } catch {
      // Safe no-op
    }
  }

  /**
   * Restores normal raw-mode input state on process.stdin if it was left hijacked.
   */
  public static restoreStdin(): void {
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    } catch {
      // Safe no-op
    }
  }

  /**
   * Performs full deterministic sanitization sweep before spawning a resurrected generation.
   */
  public static performFullSanitization(emitNotice: boolean = true): void {
    this.restoreStdin();
    this.resetAttributes();
    if (emitNotice) {
      try {
        process.stdout.write(
          "\n\x1b[36m[TERMINAL_SANITIZER]\x1b[0m Terminal state decontaminated. ANSI cursor restored.\n"
        );
      } catch {
        // Ignore
      }
    }
  }
}

