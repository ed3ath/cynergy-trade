/**
 * Minimal HTTP monitoring + emergency control server.
 * Native node:http — no framework dependency.
 *
 * GET  /health              liveness probe
 * GET  /status              portfolio, positions, emergency state (JSON)
 * GET  /events              same payload as /status, streamed live (SSE, ~2s)
 * GET  /logs                tailed trader log lines, streamed live (SSE, ~1s)
 * GET  /metrics             Prometheus text format
 * GET  /market              live per-token market feed (scanner's latest snapshots)
 * GET  /market/:token       full detail for one token + persisted price history
 * POST /emergency/kill      activate global kill switch
 * POST /emergency/resume    deactivate kill switch (requires ?confirm=yes)
 * POST /emergency/stop-entries   stop new entries only
 *
 * POST requires Authorization: Bearer $MONITOR_TOKEN (server refuses all POSTs without it).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PortfolioSnapshot, Position, Logger } from "@autonomous-trader/shared";
import type { EmergencyController } from "@autonomous-trader/core";
import type { LogTailerLike } from "./log-tailer.js";

export interface StatusPayload {
  portfolio: PortfolioSnapshot;
  positions: Position[];
  emergency: {
    killSwitch: boolean;
    stopNewEntries: boolean;
    tradingMode: string;
    disabledStrategies: string[];
  };
  regime: {
    current: string;
    solTrendPct: number;
    volatilityPct: number;
    confidence: number;
    reasons: string[];
    solSamples: number;
  };
  watchlist: Array<{ token: string; score: number; status: string; chain?: string }>;
  /** Per-chain breakdown when multiple chains trade simultaneously. */
  chains?: Array<{ chain: string; equityUsd: number; positions: number; regime: string; watchlist: number }>;
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
  getReport?: () => unknown;
  /** Equity-curve points for GET /history. */
  getHistory?: () => Promise<unknown>;
  /** Closed-position trade history for GET /trades. */
  getTrades?: () => Promise<unknown>;
  /** Live per-token market data for GET /market. */
  getMarket?: () => unknown[];
  /** Tracked-wallet swap records for GET /copytrade (dashboard Traders tab). */
  getCopyTrades?: () => unknown;
  /** Full detail + price history for GET /market/:token. Null → 404. */
  getTokenDetail?: (token: string) => Promise<unknown> | unknown;
  /** Preloaded dashboard HTML served at GET /. */
  dashboardHtml?: string | undefined;
  /** Live log stream for GET /logs. */
  logTailer?: LogTailerLike | undefined;
  /** Structured decision events for GET /activity (live Activity feed). */
  activityBus?: { subscribe(fn: (e: unknown) => void): () => void; backlog(): unknown[] } | undefined;
}): { close: () => void } {
  const { port, host, authToken, emergency, logger, getStatus, getMetrics, getReport, getHistory, getTrades, getMarket, getCopyTrades, getTokenDetail, dashboardHtml, logTailer, activityBus } = opts;
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
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        if (!dashboardHtml) return respond(res, 404, { error: "dashboard not bundled" });
        // no-store: a stale cached page means a frozen dashboard with dead endpoints
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(dashboardHtml);
        return;
      }

      if (req.method === "GET" && path === "/history") {
        if (!getHistory) return respond(res, 404, { error: "history not enabled" });
        return respond(res, 200, await getHistory());
      }

      if (req.method === "GET" && path === "/trades") {
        if (!getTrades) return respond(res, 404, { error: "trades not enabled" });
        return respond(res, 200, (await getTrades()) ?? []);
      }

      if (req.method === "GET" && path === "/market") {
        if (!getMarket) return respond(res, 404, { error: "market feed not enabled" });
        return respond(res, 200, getMarket());
      }

      if (req.method === "GET" && path === "/copytrade") {
        if (!getCopyTrades) return respond(res, 404, { error: "copytrade not enabled" });
        return respond(res, 200, getCopyTrades());
      }

      if (req.method === "GET" && path.startsWith("/market/")) {
        if (!getTokenDetail) return respond(res, 404, { error: "market feed not enabled" });
        const token = decodeURIComponent(path.slice("/market/".length));
        const detail = await getTokenDetail(token);
        if (detail === null || detail === undefined) {
          return respond(res, 404, { error: "token not tracked" });
        }
        return respond(res, 200, detail);
      }

      if (req.method === "GET" && path === "/health") {
        return respond(res, 200, { status: "ok", uptimeMs: Date.now() - startedAt });
      }

      if (req.method === "GET" && path === "/status") {
        const status = getStatus();
        status.uptimeMs = Date.now() - startedAt;
        return respond(res, 200, status);
      }

      if (req.method === "GET" && path === "/events") {
        // Server-Sent Events: push the /status payload every 2s so the dashboard
        // renders every decision-cycle tick the moment it lands. Auto-reconnects.
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write("retry: 2000\n\n");
        const push = () => {
          if (res.destroyed) {
            clearInterval(timer);
            return;
          }
          const status = getStatus();
          status.uptimeMs = Date.now() - startedAt;
          const body = JSON.stringify(status, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
          res.write(`data: ${body}\n\n`);
        };
        push();
        const timer = setInterval(push, 2000);
        // res, not req: on a bodyless GET the IncomingMessage 'close' fires as soon
        // as the request is consumed — clearing the interval after the first frame
        res.on("close", () => clearInterval(timer));
        return;
      }

      if (req.method === "GET" && path === "/activity") {
        // SSE: structured decision events (every tick, skip/enter/reject/exit).
        if (!activityBus) return respond(res, 404, { error: "activity not enabled" });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write("retry: 2000\n\n");
        for (const e of activityBus.backlog()) res.write(`data: ${JSON.stringify(e)}\n\n`);
        const unsub = activityBus.subscribe((e) => {
          if (res.destroyed) {
            unsub();
            return;
          }
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        });
        res.on("close", unsub);
        return;
      }

      if (req.method === "GET" && path === "/logs") {
        if (!logTailer) return respond(res, 404, { error: "log streaming not enabled" });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write("retry: 2000\n\n");
        // backlog first (recent history), then live tail
        for (const line of logTailer.backlog()) res.write(`data: ${line}\n\n`);
        const unsub = logTailer.subscribe((line) => {
          if (res.destroyed) {
            unsub();
            return;
          }
          res.write(`data: ${line.replace(/\n/g, " ")}\n\n`);
        });
        res.on("close", unsub);
        return;
      }

      if (req.method === "GET" && path === "/report") {
        if (!getReport) return respond(res, 404, { error: "reporting not enabled" });
        return respond(res, 200, getReport());
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
  // Stringify BEFORE writing headers: pg bigint columns arrive as BigInt and
  // JSON.stringify throws on it — a monitor GET must never kill the process.
  const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (res.headersSent) {
    res.end(payload);
    return;
  }
  res.writeHead(code, { "content-type": "application/json" });
  res.end(payload);
}
