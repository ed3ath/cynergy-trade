/**
 * Tails the trader's JSON-lines log file and fans raw lines out to subscribers.
 * Poll-based: fs.watch is unreliable for cmd-redirected append files on Windows.
 * Forwards raw single lines (logger writes one JSON object per line; the
 * watchdog script echoes plain-text lines — both are passed through and the
 * dashboard parses/classifies). The server stays a dumb pipe.
 */
import { open } from "node:fs/promises";

export interface LogTailerLike {
  backlog(): string[];
  subscribe(fn: (line: string) => void): () => void;
  start(pollMs?: number): void;
  stop(): void;
}

export class LogTailer implements LogTailerLike {
  private offset = 0;
  private readonly ring: string[] = [];
  private readonly subs = new Set<(line: string) => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly path: string,
    private readonly ringSize = 400,
    private readonly seedBytes = 256 * 1024,
  ) {}

  backlog(): string[] {
    return [...this.ring];
  }

  subscribe(fn: (line: string) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  start(pollMs = 1000): void {
    if (this.timer) return;
    void this.poll(true);
    this.timer = setInterval(() => void this.poll(false), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(seed: boolean): Promise<void> {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(this.path, "r");
      const size = (await fh.stat()).size;
      if (seed) this.offset = Math.max(0, size - this.seedBytes); // backlog, not full history
      if (size < this.offset) this.offset = 0; // truncated/recreated under us
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      await fh.read(buf, 0, buf.length, this.offset);
      this.offset = size;
      // Never emit a half-written line: stop at the last newline and rewind.
      let end = buf.length;
      if (buf[end - 1] !== 10) {
        const lastNl = buf.lastIndexOf(10);
        if (lastNl === -1) {
          this.offset -= end;
          return;
        }
        end = lastNl + 1;
        this.offset -= buf.length - end;
      }
      let text = buf.subarray(0, end).toString("utf8");
      if (seed) {
        const nl = text.indexOf("\n");
        if (nl !== -1) text = text.slice(nl + 1); // seed may start mid-line
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this.ring.push(line);
        for (const fn of this.subs) fn(line);
      }
      if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    } catch {
      // file missing or briefly locked — retry on the next tick
    } finally {
      await fh?.close().catch(() => {});
    }
  }
}
