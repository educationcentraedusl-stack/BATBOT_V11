import { CLIDashboard } from "./dashboard";

type StreamWriteCallback = (err?: Error | null) => void;
type StreamWriteFn = NodeJS.WriteStream["write"];

export class TerminalOutputMux {
  private static instance: TerminalOutputMux | null = null;
  private originalStdoutWrite: StreamWriteFn | null = null;
  private originalStderrWrite: StreamWriteFn | null = null;
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
    const muxStdoutWrite = (
      chunk: Uint8Array | string,
      encodingOrCallback?: BufferEncoding | StreamWriteCallback,
      callback?: StreamWriteCallback
    ): boolean => {
      let cb: StreamWriteCallback | undefined = callback;
      let enc: BufferEncoding | undefined;
      if (typeof encodingOrCallback === "function") {
        cb = encodingOrCallback;
      } else {
        enc = encodingOrCallback;
      }

      const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(enc ?? "utf8");

      // Allow prompt text, readline control codes, and user keypress echoes to pass through
      const isPromptString =
        str.includes("Recalibration triggered") ||
        str.includes("Modal Cloud GPU") ||
        str.includes("(Y/N)") ||
        str.includes("[BATBOT_V11]") ||
        str.trim() === "y" ||
        str.trim() === "n" ||
        str.trim() === "yes" ||
        str.trim() === "no";

      if (isPromptString && this.originalStdoutWrite) {
        if (enc !== undefined) {
          return this.originalStdoutWrite(chunk, enc, cb);
        }
        return this.originalStdoutWrite(chunk, cb);
      }

      // Buffer background logs so they don't break the CLI prompt line
      this.logBuffer.push(str);
      if (cb) cb();
      return true;
    };

    const stdoutTarget: { write: StreamWriteFn } = process.stdout;
    stdoutTarget.write = muxStdoutWrite;

    // Override process.stderr.write to buffer background error/warning logs during prompt session
    const muxStderrWrite = (
      chunk: Uint8Array | string,
      encodingOrCallback?: BufferEncoding | StreamWriteCallback,
      callback?: StreamWriteCallback
    ): boolean => {
      let cb: StreamWriteCallback | undefined = callback;
      let enc: BufferEncoding | undefined;
      if (typeof encodingOrCallback === "function") {
        cb = encodingOrCallback;
      } else {
        enc = encodingOrCallback;
      }

      const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(enc ?? "utf8");
      this.logBuffer.push(str);
      if (cb) cb();
      return true;
    };

    const stderrTarget: { write: StreamWriteFn } = process.stderr;
    stderrTarget.write = muxStderrWrite;
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
