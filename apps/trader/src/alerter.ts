/**
 * Alerting (spec §65) — critical events only.
 *
 * Routine profitable trades NEVER alert (explicit spec rule). Alerts fire for:
 * kill switch, loss limits, emergency drawdown, execution failures (deduped),
 * restart-with-open-positions, repeated provider outage.
 *
 * Transport: Telegram bot API (ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID).
 * No-op when unset — alerting is strictly additive.
 */
import type { Logger } from "@autonomous-trader/shared";

export type AlertSeverity = "CRITICAL" | "WARNING" | "INFO";

export interface AlerterConfig {
  botToken?: string;
  chatId?: string;
  /** Same dedupe key won't re-alert within this window. Default 10 min. */
  dedupeWindowMs: number;
}

export class Alerter {
  private lastSentAt = new Map<string, number>();
  private readonly enabled: boolean;

  constructor(
    private readonly cfg: AlerterConfig,
    private readonly log: Logger,
  ) {
    this.enabled = Boolean(cfg.botToken && cfg.chatId);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Fire-and-forget. Deduped by key. Never throws into the caller. */
  alert(severity: AlertSeverity, key: string, message: string): void {
    if (!this.enabled) return;
    if (!this.passesDedupe(key)) return;

    const icon = severity === "CRITICAL" ? "🔴" : severity === "WARNING" ? "🟠" : "🔵";
    const text = `${icon} [${severity}] cynergy-trade\n${message}`;

    void this.send(text).catch((err) => {
      this.log.warn("Alert delivery failed", { key, error: (err as Error).message });
    });
  }

  private passesDedupe(key: string): boolean {
    const now = Date.now();
    const last = this.lastSentAt.get(key);
    if (last !== undefined && now - last < this.cfg.dedupeWindowMs) return false;
    this.lastSentAt.set(key, now);
    return true;
  }

  private async send(text: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${this.cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.cfg.chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}
