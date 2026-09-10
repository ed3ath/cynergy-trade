/**
 * Minimal HTTP monitoring + emergency control server.
 * Native node:http — no framework dependency.
 *
 * GET  /health              liveness probe
 * GET  /status              portfolio, positions, emergency state (JSON)
 * GET  /metrics             Prometheus text format
 * POST /emergency/kill      activate global kill switch
 * POST /emergency/resume    deactivate kill switch (requires ?confirm=yes)
 * POST /emergency/stop-entries   stop new entries only
 *
 * POST requires Authorization: Bearer $MONITOR_TOKEN (server refuses all POSTs without it).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PortfolioSnapshot, Position, Logger } from "@autonomous-trader/shared";
import type { EmergencyController } from "@autonomous-trader/core";

export interface StatusPayload {
  portfolio: PortfolioSnapshot;
  positions: Position[];
  emergency: {
    killSwitch: boolean;
    stopNewEntries: boolean;
    tradingMode: string;
    disabledStrategies: string[];
  };
  watchlist: Array<{ token: string; score: number; status: string }>;
  uptimeMs: number;
  version: string;
}

export function startHttpServer(opts: {
  port: number;
  host: string;
  authToken?: string;
  emergency: EmergencyController;
  logger: Logger;
  getStatus: () => StatusPayload;
  getMetrics: () => Record<string, number>;
}): { close: () => void } {
  const { port, host, authToken, emergency, logger, getStatus, getMetrics } = opts;
  const startedAt = Date.now();

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error("HTTP handler error", { error: (err as Error).message });
      respond(res, 500, { error: "internal error" });
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? "/", "http://local");
      const path = url.pathname;

      // ── Auth check for mutating endpoints ──────────────────────────────────
      if (req.method === "POST") {
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (!authToken) {
          return respond(res, 403, { error: "MONITOR_TOKEN not configured — POST endpoints disabled" });
        }
        if (token !== authToken) {
          return respond(res, 401, { error: "unauthorized" });
        }
      }

      // ── Routes ──────────────────────────────────────────────────────────────
      if (req.method === "GET" && path === "/health") {
        return respond(res, 200, { status: "ok", uptimeMs: Date.now() - startedAt });
      }

      if (req.method === "GET" && path === "/status") {
        const status = getStatus();
        status.uptimeMs = Date.now() - startedAt;
        return respond(res, 200, status);
      }

      if (req.method === "GET" && path === "/metrics") {
        const metrics = getMetrics();
        const lines = Object.entries(metrics)
          .map(([k, v]) => `${k} ${v}`)
          .join("\n");
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(lines + "\n");
        return;
      }

      if (req.method === "POST" && path === "/emergency/kill") {
        await emergency.activateKillSwitch(`HTTP kill by operator at ${new Date().toISOString()}`);
        logger.error("KILL SWITCH ACTIVATED via HTTP");
        return respond(res, 200, { status: "kill_switch_activated" });
      }

      if (req.method === "POST" && path === "/emergency/resume") {
        if (url.searchParams.get("confirm") !== "yes") {
          return respond(res, 400, { error: "requires ?confirm=yes" });
        }
        await emergency.deactivateKillSwitch();
        await emergency.setStopNewEntries(false);
        await emergency.setCloseAllPositions(false);
        logger.info("Kill switch deactivated via HTTP");
        return respond(res, 200, { status: "resumed" });
      }

      if (req.method === "POST" && path === "/emergency/stop-entries") {
        await emergency.setStopNewEntries(true);
        logger.warn("New entries stopped via HTTP");
        return respond(res, 200, { status: "entries_stopped" });
      }

      respond(res, 404, { error: "not found" });
    }
  });

  server.listen(port, host, () => {
    logger.info("HTTP monitor listening", { host, port });
  });

  return { close: () => server.close() };
}

function respond(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
