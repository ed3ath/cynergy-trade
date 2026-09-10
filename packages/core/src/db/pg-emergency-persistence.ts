/**
 * Postgres-backed emergency state persistence — kill switch survives restarts.
 */
import type { EmergencyStatePersistence, EmergencyState } from "../risk/emergency-controller.js";
import type { Database } from "./database.js";

export class PgEmergencyPersistence implements EmergencyStatePersistence {
  constructor(private readonly db: Database) {}

  async load(): Promise<Partial<EmergencyState>> {
    const keys = ["kill_switch", "stop_new_entries", "close_all_positions",
                  "read_only_mode", "trading_mode", "disabled_strategies", "disabled_providers"];

    const out: Partial<EmergencyState> = {};
    for (const key of keys) {
      const { rows } = await this.db.query<{ value: string }>(
        `SELECT value FROM system_state WHERE key = $1`, [key],
      );
      const v = rows[0]?.value;
      if (v === undefined) continue;

      switch (key) {
        case "kill_switch":            out.killSwitch = v === "true"; break;
        case "stop_new_entries":       out.stopNewEntries = v === "true"; break;
        case "close_all_positions":    out.closeAllPositions = v === "true"; break;
        case "read_only_mode":         out.readOnlyMode = v === "true"; break;
        case "trading_mode":           out.tradingMode = v as "PAPER" | "SHADOW" | "LIVE"; break;
        case "disabled_strategies":    out.disabledStrategies = new Set(JSON.parse(v) as string[]); break;
        case "disabled_providers":     out.disabledProviders = new Set(JSON.parse(v) as string[]); break;
      }
    }
    return out;
  }

  async save(state: EmergencyState): Promise<void> {
    const entries: Array<[string, string]> = [
      ["kill_switch", String(state.killSwitch)],
      ["stop_new_entries", String(state.stopNewEntries)],
      ["close_all_positions", String(state.closeAllPositions)],
      ["read_only_mode", String(state.readOnlyMode)],
      ["trading_mode", state.tradingMode],
      ["disabled_strategies", JSON.stringify([...state.disabledStrategies])],
      ["disabled_providers", JSON.stringify([...state.disabledProviders])],
    ];

    for (const [key, value] of entries) {
      await this.db.query(
        `INSERT INTO system_state (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
      );
    }
  }
}
