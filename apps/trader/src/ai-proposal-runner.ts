/** Read-only research only. The host drains ready proposals in its serialized
 * financial loop and revalidates them there; this class never applies actions. */
export interface AiProposalContext {
  readonly signal: AbortSignal;
  readonly snapshotAt: number;
  readonly deadlineAt: number;
}

export interface AiReadyProposal<T> {
  readonly snapshotAt: number;
  readonly expiresAt: number;
  /** Detached and recursively frozen. Operations must return plain data. */
  readonly value: Readonly<T>;
}

export class AiProposalRunner<T> {
  private flight: AbortController | undefined;
  private ready: AiReadyProposal<T> | undefined;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: { timeoutMs: number; maxAgeMs: number }) {
    for (const ms of [options.timeoutMs, options.maxAgeMs]) {
      if (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647) throw new RangeError("Invalid AI proposal duration");
    }
    this.options = Object.freeze({ ...options });
  }

  /** Includes timed-out work that has not actually settled: never overlap it. */
  get inFlight(): boolean {
    return this.flight !== undefined;
  }

  start(operation: (context: AiProposalContext) => Promise<T>): boolean {
    if (this.disposed || this.flight) return false;
    const snapshotAt = Date.now();
    if (this.ready && this.ready.expiresAt > snapshotAt) return false;
    this.ready = undefined;
    const expiresAt = snapshotAt + this.options.maxAgeMs;
    const deadlineAt = Math.min(snapshotAt + this.options.timeoutMs, expiresAt);
    const controller = new AbortController();
    this.flight = controller;
    const timer = setTimeout(() => controller.abort(), deadlineAt - snapshotAt);
    this.timer = timer;

    void Promise.resolve().then(() => {
      if (Date.now() >= deadlineAt) controller.abort();
      controller.signal.throwIfAborted();
      return operation(Object.freeze({ signal: controller.signal, snapshotAt, deadlineAt }));
    }).then((value) => {
      if (this.disposed || controller.signal.aborted || Date.now() >= deadlineAt) return;
      const detached: T = structuredClone(value);
      freezeData(detached);
      if (this.disposed || controller.signal.aborted || Date.now() >= deadlineAt) return;
      this.ready = Object.freeze({ snapshotAt, expiresAt, value: detached });
    }).catch(() => {
      // Failure is no proposal, not permission to trade from an old snapshot.
    }).finally(() => {
      clearTimeout(timer);
      this.timer = undefined;
      this.flight = undefined;
    });
    return true;
  }

  takeReady(now = Date.now()): AiReadyProposal<T> | undefined {
    const ready = this.ready;
    this.ready = undefined;
    if (this.disposed || !ready || !Number.isFinite(now) || now < ready.snapshotAt || now >= ready.expiresAt) return undefined;
    return ready;
  }

  dispose(): void {
    this.disposed = true;
    this.ready = undefined;
    this.flight?.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function freezeData(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("AI proposals must contain only plain data");
  }
  seen.add(value);
  for (const child of Object.values(value)) freezeData(child, seen);
  Object.freeze(value);
}
