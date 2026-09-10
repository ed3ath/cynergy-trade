/**
 * Token lifecycle state machine.
 * Enforces valid transitions — no token can skip from DISCOVERED directly to OPEN.
 */
import type { TokenLifecycleStatus } from "@autonomous-trader/shared";

// Valid forward transitions
const TRANSITIONS: Record<TokenLifecycleStatus, TokenLifecycleStatus[]> = {
  DISCOVERED:      ["OBSERVING", "REJECTED"],
  OBSERVING:       ["SCREENING", "REJECTED"],
  SCREENING:       ["ELIGIBLE", "REJECTED"],
  ELIGIBLE:        ["WATCHLIST", "REJECTED"],
  WATCHLIST:       ["TRADE_CANDIDATE", "REJECTED", "ARCHIVED"],
  TRADE_CANDIDATE: ["ENTERED", "WATCHLIST", "REJECTED"],
  ENTERED:         ["OPEN", "EXITING", "REJECTED"],
  OPEN:            ["EXITING"],
  EXITING:         ["CLOSED"],
  CLOSED:          ["ARCHIVED"],
  REJECTED:        ["ARCHIVED"],
  ARCHIVED:        [],
};

export class TokenStateMachine {
  private _status: TokenLifecycleStatus;
  private readonly history: Array<{ from: TokenLifecycleStatus; to: TokenLifecycleStatus; at: Date }> = [];

  constructor(initial: TokenLifecycleStatus = "DISCOVERED") {
    this._status = initial;
  }

  get status(): TokenLifecycleStatus {
    return this._status;
  }

  canTransition(to: TokenLifecycleStatus): boolean {
    return (TRANSITIONS[this._status] ?? []).includes(to);
  }

  transition(to: TokenLifecycleStatus): void {
    if (!this.canTransition(to)) {
      throw new Error(`Invalid token transition: ${this._status} → ${to}`);
    }
    this.history.push({ from: this._status, to, at: new Date() });
    this._status = to;
  }

  getHistory() {
    return [...this.history];
  }
}

// ─── Order state machine ───────────────────────────────────────────────────────
import type { OrderStatus } from "@autonomous-trader/shared";

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED:    ["VALIDATING", "CANCELLED"],
  VALIDATING: ["SIMULATING", "FAILED", "CANCELLED"],
  SIMULATING: ["SIGNED", "FAILED", "CANCELLED"],
  SIGNED:     ["SUBMITTED", "FAILED", "CANCELLED"],
  SUBMITTED:  ["CONFIRMING", "FAILED", "UNKNOWN"],
  CONFIRMING: ["CONFIRMED", "FAILED", "UNKNOWN"],
  CONFIRMED:  [],
  FAILED:     [],
  UNKNOWN:    ["CONFIRMED", "FAILED"],
  CANCELLED:  [],
};

export class OrderStateMachine {
  private _status: OrderStatus;

  constructor(initial: OrderStatus = "CREATED") {
    this._status = initial;
  }

  get status(): OrderStatus {
    return this._status;
  }

  canTransition(to: OrderStatus): boolean {
    return (ORDER_TRANSITIONS[this._status] ?? []).includes(to);
  }

  transition(to: OrderStatus): void {
    if (!this.canTransition(to)) {
      throw new Error(`Invalid order transition: ${this._status} → ${to}`);
    }
    this._status = to;
  }
}

// ─── Position state machine ───────────────────────────────────────────────────
import type { PositionStatus } from "@autonomous-trader/shared";

const POSITION_TRANSITIONS: Record<PositionStatus, PositionStatus[]> = {
  OPENING:      ["OPEN", "ERROR"],
  OPEN:         ["PARTIAL_EXIT", "CLOSING", "ERROR"],
  PARTIAL_EXIT: ["OPEN", "CLOSING"],
  CLOSING:      ["CLOSED", "ERROR"],
  CLOSED:       [],
  ERROR:        ["CLOSING"],
};

export class PositionStateMachine {
  private _status: PositionStatus;

  constructor(initial: PositionStatus = "OPENING") {
    this._status = initial;
  }

  get status(): PositionStatus {
    return this._status;
  }

  canTransition(to: PositionStatus): boolean {
    return (POSITION_TRANSITIONS[this._status] ?? []).includes(to);
  }

  transition(to: PositionStatus): void {
    if (!this.canTransition(to)) {
      throw new Error(`Invalid position transition: ${this._status} → ${to}`);
    }
    this._status = to;
  }
}
