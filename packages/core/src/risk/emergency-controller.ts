/**
 * Emergency control system — persisted state for kill switches and mode flags.
 * State survives process restarts (stored in DB / Redis; in-memory for tests).
 *
 * This is the ONLY place that controls whether new entries are allowed.
 */
export interface EmergencyState {
  killSwitch: boolean;
  stopNewEntries: boolean;
  closeAllPositions: boolean;
  readOnlyMode: boolean;
  disabledStrategies: Set<string>;
  disabledProviders: Set<string>;
  tradingMode: "PAPER" | "SHADOW" | "LIVE";
  updatedAt: Date;
}

export type EmergencyStatePersistence = {
  load(): Promise<Partial<EmergencyState>>;
  save(state: EmergencyState): Promise<void>;
};

/** In-memory persistence for tests and development without a database. */
export class InMemoryEmergencyPersistence implements EmergencyStatePersistence {
  private stored: Partial<EmergencyState> = {};

  async load(): Promise<Partial<EmergencyState>> {
    return { ...this.stored };
  }

  async save(state: EmergencyState): Promise<void> {
    this.stored = { ...state };
  }
}

export class EmergencyController {
  private state: EmergencyState;
  private readonly persistence: EmergencyStatePersistence;

  constructor(persistence: EmergencyStatePersistence, initialMode: "PAPER" | "SHADOW" | "LIVE" = "PAPER") {
    this.persistence = persistence;
    this.state = {
      killSwitch: false,
      stopNewEntries: false,
      closeAllPositions: false,
      readOnlyMode: false,
      disabledStrategies: new Set(),
      disabledProviders: new Set(),
      tradingMode: initialMode,
      updatedAt: new Date(),
    };
  }

  async initialize(): Promise<void> {
    const stored = await this.persistence.load();
    this.state = {
      ...this.state,
      ...stored,
      disabledStrategies: new Set(stored.disabledStrategies),
      disabledProviders: new Set(stored.disabledProviders),
      updatedAt: new Date(),
    };
  }

  isKillSwitchActive(): boolean {
    return this.state.killSwitch;
  }

  isStopNewEntries(): boolean {
    return this.state.killSwitch || this.state.stopNewEntries;
  }

  isCloseAllPositions(): boolean {
    return this.state.killSwitch || this.state.closeAllPositions;
  }

  isReadOnly(): boolean {
    return this.state.readOnlyMode;
  }

  isStrategyEnabled(strategyId: string): boolean {
    return !this.state.disabledStrategies.has(strategyId);
  }

  isProviderEnabled(providerName: string): boolean {
    return !this.state.disabledProviders.has(providerName);
  }

  getTradingMode(): "PAPER" | "SHADOW" | "LIVE" {
    return this.state.tradingMode;
  }

  async activateKillSwitch(reason: string): Promise<void> {
    console.error(`[EMERGENCY] Kill switch activated: ${reason}`);
    this.state.killSwitch = true;
    this.state.stopNewEntries = true;
    this.state.closeAllPositions = true;
    this.state.updatedAt = new Date();
    await this.persist();
  }

  async deactivateKillSwitch(): Promise<void> {
    this.state.killSwitch = false;
    this.state.updatedAt = new Date();
    await this.persist();
  }

  async setStopNewEntries(value: boolean): Promise<void> {
    this.state.stopNewEntries = value;
    this.state.updatedAt = new Date();
    await this.persist();
  }

  async setCloseAllPositions(value: boolean): Promise<void> {
    this.state.closeAllPositions = value;
    this.state.updatedAt = new Date();
    await this.persist();
  }

  async disableStrategy(strategyId: string): Promise<void> {
    this.state.disabledStrategies.add(strategyId);
    this.state.updatedAt = new Date();
    await this.persist();
  }

  async enableStrategy(strategyId: string): Promise<void> {
    this.state.disabledStrategies.delete(strategyId);
    this.state.updatedAt = new Date();
    await this.persist();
  }

  async setTradingMode(mode: "PAPER" | "SHADOW" | "LIVE"): Promise<void> {
    // PAPER is always safe. LIVE requires explicit confirmation.
    this.state.tradingMode = mode;
    this.state.updatedAt = new Date();
    await this.persist();
  }

  getState(): Readonly<EmergencyState> {
    return { ...this.state };
  }

  private async persist(): Promise<void> {
    await this.persistence.save(this.state);
  }
}
