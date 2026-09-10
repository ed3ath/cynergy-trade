import { describe, it, expect } from "vitest";
import {
  TokenStateMachine,
  OrderStateMachine,
  PositionStateMachine,
} from "../state-machines.js";

describe("TokenStateMachine", () => {
  it("starts DISCOVERED", () => {
    expect(new TokenStateMachine().status).toBe("DISCOVERED");
  });

  it("follows valid path to CLOSED", () => {
    const sm = new TokenStateMachine();
    sm.transition("OBSERVING");
    sm.transition("SCREENING");
    sm.transition("ELIGIBLE");
    sm.transition("WATCHLIST");
    sm.transition("TRADE_CANDIDATE");
    sm.transition("ENTERED");
    sm.transition("OPEN");
    sm.transition("EXITING");
    sm.transition("CLOSED");
    expect(sm.status).toBe("CLOSED");
  });

  it("throws on invalid transition", () => {
    const sm = new TokenStateMachine();
    expect(() => sm.transition("OPEN")).toThrow();
  });

  it("can reject from any early state", () => {
    for (const state of ["DISCOVERED", "OBSERVING", "SCREENING", "ELIGIBLE", "WATCHLIST"] as const) {
      const sm = new TokenStateMachine(state);
      sm.transition("REJECTED");
      expect(sm.status).toBe("REJECTED");
    }
  });

  it("records history", () => {
    const sm = new TokenStateMachine();
    sm.transition("OBSERVING");
    sm.transition("SCREENING");
    expect(sm.getHistory()).toHaveLength(2);
    expect(sm.getHistory()[0]!.from).toBe("DISCOVERED");
    expect(sm.getHistory()[0]!.to).toBe("OBSERVING");
  });

  it("ARCHIVED is terminal", () => {
    const sm = new TokenStateMachine("ARCHIVED");
    expect(sm.canTransition("DISCOVERED")).toBe(false);
    expect(() => sm.transition("DISCOVERED")).toThrow();
  });
});

describe("OrderStateMachine", () => {
  it("valid submission flow", () => {
    const sm = new OrderStateMachine();
    sm.transition("VALIDATING");
    sm.transition("SIMULATING");
    sm.transition("SIGNED");
    sm.transition("SUBMITTED");
    sm.transition("CONFIRMING");
    sm.transition("CONFIRMED");
    expect(sm.status).toBe("CONFIRMED");
  });

  it("can fail from SUBMITTED", () => {
    const sm = new OrderStateMachine("SUBMITTED");
    sm.transition("FAILED");
    expect(sm.status).toBe("FAILED");
  });

  it("UNKNOWN can resolve to CONFIRMED or FAILED", () => {
    const sm1 = new OrderStateMachine("UNKNOWN");
    sm1.transition("CONFIRMED");
    expect(sm1.status).toBe("CONFIRMED");

    const sm2 = new OrderStateMachine("UNKNOWN");
    sm2.transition("FAILED");
    expect(sm2.status).toBe("FAILED");
  });

  it("CONFIRMED is terminal", () => {
    const sm = new OrderStateMachine("CONFIRMED");
    expect(() => sm.transition("FAILED")).toThrow();
  });
});

describe("PositionStateMachine", () => {
  it("OPENING → OPEN → CLOSING → CLOSED", () => {
    const sm = new PositionStateMachine();
    sm.transition("OPEN");
    sm.transition("CLOSING");
    sm.transition("CLOSED");
    expect(sm.status).toBe("CLOSED");
  });

  it("supports partial exit cycle", () => {
    const sm = new PositionStateMachine("OPEN");
    sm.transition("PARTIAL_EXIT");
    sm.transition("OPEN");
    sm.transition("PARTIAL_EXIT");
    sm.transition("CLOSING");
    sm.transition("CLOSED");
    expect(sm.status).toBe("CLOSED");
  });

  it("ERROR can transition to CLOSING", () => {
    const sm = new PositionStateMachine("ERROR");
    sm.transition("CLOSING");
    expect(sm.status).toBe("CLOSING");
  });
});
