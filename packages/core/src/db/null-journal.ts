/**
 * Null journal — used when DB is not configured (dev/paper without postgres).
 * Implements the same interface, does nothing. Never throws.
 */
import type { JournalRepository } from "./journal.js";

export class NullJournal {
  // All methods are no-ops. Typed loosely on purpose — swap in JournalRepository when DB available.
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}

export type Journal = JournalRepository | NullJournal;

/** Creates a proxy that swallows all calls — useful when DB absent. */
export function createNullJournal(): NullJournal {
  return new Proxy({}, {
    get: () => async () => undefined,
  }) as NullJournal;
}
