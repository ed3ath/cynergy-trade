import { randomUUID } from "node:crypto";

/** Generates a unique trade intent ID with a prefix for readability. */
export function generateTradeIntentId(): string {
  return `ti_${randomUUID().replace(/-/g, "")}`;
}

export function generateOrderId(): string {
  return `ord_${randomUUID().replace(/-/g, "")}`;
}

export function generatePositionId(): string {
  return `pos_${randomUUID().replace(/-/g, "")}`;
}

export function generateEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "")}`;
}

export function generateExperimentId(): string {
  return `exp_${randomUUID().replace(/-/g, "")}`;
}
