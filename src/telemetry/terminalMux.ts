import { CLIDashboard } from "./dashboard";

export class TerminalOutputMux {
  private static instance: TerminalOutputMux | null = null;
  private originalStdoutWrite: typeof process.stdout.write | null = null;
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

    // Backup original process.stdout.write
    this.originalStdoutWrite = process.stdout.write.bind(process.stdout);

    // Override process.stdout.write to buffer non-interactive logs while readline prompt is active
    (process.stdout as any).write = (chunk: any, encoding?: any, callback?: any): boolean => {
      const str = typeof chunk === "string" ? chunk : chunk.toString(encoding || "utf8");
      
      // Allow readline prompt text itself (which contains ANSI color tags or question text) to pass through
      if (str.includes("[BATBOT_V11]") && (str.includes("Recalibration triggered") || str.includes("Modal Cloud GPU"))) {
        if (this.originalStdoutWrite) {
          return this.originalStdoutWrite(chunk, encoding, callback);
        }
      }
      
      // Buffer other logs so they don't break the CLI prompt line
      this.logBuffer.push(str);
      if (typeof callback === "function") callback();
      return true;
    };
  }

  public endPromptSession(): void {
    if (!this.isPromptActive) return;

    // Restore original stdout write
    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
      this.originalStdoutWrite = null;
    }

    this.isPromptActive = false;
    CLIDashboard.setPromptActive(false);
    this.logBuffer = [];
  }

  public isPrompting(): boolean {
    return this.isPromptActive;
  }
}
