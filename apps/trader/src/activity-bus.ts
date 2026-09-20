/**
 * Activity bus — structured, human-readable trader events for the dashboard's
 * live Activity feed. One publish per decision/act so every tick is visible
 * even when the market is quiet (kind "cycle" = heartbeat).
 *
 * In-process ring buffer + fan-out; SSE endpoint in http-server.ts.
 */
export type ActivityKind = "cycle" | "skip" | "enter" | "reject" | "exit" | "info";

export interface ActivityEvent {
  at: string; // ISO timestamp
  kind: ActivityKind;
  token?: string;
  detail: string;
  data?: Record<string, unknown>;
}

export class ActivityBus {
  private readonly ring: ActivityEvent[] = [];
  private readonly subscribers = new Set<(e: ActivityEvent) => void>();

  constructor(private readonly capacity = 200) {}

  publish(kind: ActivityKind, detail: string, extra?: { token?: string; data?: Record<string, unknown> }): void {
    const e: ActivityEvent = { at: new Date().toISOString(), kind, detail, ...extra };
    this.ring.push(e);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
    for (const s of this.subscribers) {
      try { s(e); } catch { /* a broken subscriber must not break the cycle */ }
    }
  }

  subscribe(fn: (e: ActivityEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  backlog(): ActivityEvent[] {
    return [...this.ring];
  }
}
