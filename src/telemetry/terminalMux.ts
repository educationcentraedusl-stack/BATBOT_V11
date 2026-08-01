import { CLIDashboard } from "./dashboard";

export class TerminalOutputMux {
  private static instance: TerminalOutputMux | null = null;
  private originalStdoutWrite: typeof process.stdout.write | null = null;
  private originalStderrWrite: typeof process.stderr.write | null = null;
  private isPromptActive = false;
  private logBuffer: string[] = [];

  private constructor() {}

  public static getInstance(): TerminalOutputMux {
    if (!TerminalOutputMux.instance) {
      TerminalOutputMux.instance = new TerminalOutputMux();
    }
    return TerminalOutputMux.instance;
  }

  public startPromptSession(): void {
    if (this.isPromptActive) return;
    this.isPromptActive = true;
    CLIDashboard.setPromptActive(true);

    // Backup original process.stdout.write and process.stderr.write
    this.originalStdoutWrite = process.stdout.write.bind(process.stdout);
    this.originalStderrWrite = process.stderr.write.bind(process.stderr);

    // Override process.stdout.write to pass prompt and readline input echoes, buffering background logs
    (process.stdout as any).write = (chunk: any, encoding?: any, callback?: any): boolean => {
      const str = typeof chunk === "string" ? chunk : chunk.toString(encoding || "utf8");

      // Allow prompt text, readline control codes, and user keypress echoes to pass through
      const isPromptString =
        str.includes("Recalibration triggered") ||
        str.includes("Modal Cloud GPU") ||
        str.includes("(Y/N)") ||
        str.includes("[BATBOT_V11]") ||
        !str.includes("\n") ||
        str.trim() === "y" ||
        str.trim() === "n" ||
        str.trim() === "yes" ||
        str.trim() === "no";

      if (isPromptString && this.originalStdoutWrite) {
        return this.originalStdoutWrite(chunk, encoding, callback);
      }

      // Buffer background logs so they don't break the CLI prompt line
      this.logBuffer.push(str);
      if (typeof callback === "function") callback();
      return true;
    };

    // Override process.stderr.write to buffer background error/warning logs during prompt session
    (process.stderr as any).write = (chunk: any, encoding?: any, callback?: any): boolean => {
      const str = typeof chunk === "string" ? chunk : chunk.toString(encoding || "utf8");
      this.logBuffer.push(str);
      if (typeof callback === "function") callback();
      return true;
    };
  }

  public endPromptSession(): void {
    if (!this.isPromptActive) return;

    // Restore original stdout & stderr writes
    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
      this.originalStdoutWrite = null;
    }
    if (this.originalStderrWrite) {
      process.stderr.write = this.originalStderrWrite;
      this.originalStderrWrite = null;
    }

    this.isPromptActive = false;
    CLIDashboard.setPromptActive(false);

    // Flush buffered logs cleanly to stdout if any were buffered during prompt session
    if (this.logBuffer.length > 0) {
      const bufferedLogs = this.logBuffer.join("");
      this.logBuffer = [];
      if (bufferedLogs.trim().length > 0) {
        process.stdout.write("\n--- BUFFERED LOGS DURING RECALIBRATION PROMPT ---\n" + bufferedLogs + "\n");
      }
    }
  }

  public isPrompting(): boolean {
    return this.isPromptActive;
  }
}
