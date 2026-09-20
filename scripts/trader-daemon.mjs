#!/usr/bin/env node
// Trader daemon: starts the trader when the monitor port is down, restarts it
// on exit. Replaces start-trader.cmd + watchdog.cmd — pure node, no cmd/vbs.
//
// Registered as scheduled task "CynergyTraderWatchdog" (S4U principal = runs
// hidden, "whether user is logged on or not"). Task trigger repeats every 2min
// as a backstop; the MultipleInstances=IgnoreNew policy keeps one daemon alive.
//
// Stdout/stderr of both daemon and trader append to logs/trader.log.

import { spawn } from "node:child_process";
import { appendFileSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.MONITOR_PORT ?? 3000);
const CHECK_INTERVAL_MS = 15_000;

/** Minimal .env loader — KEY=VALUE lines, # comments, optional quotes. */
function loadEnv(path) {
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function isPortUp(port) {
  return new Promise((yes) => {
    const sock = createConnection({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      yes(true);
    });
    sock.once("error", () => yes(false));
    sock.setTimeout(2_000, () => { sock.destroy(); yes(false); });
  });
}

// Daemon messages go into trader.log too — task-run stdout is discarded.
const boot = (msg) => {
  const line = `${new Date().toISOString()} [daemon] ${msg}\n`;
  try { appendFileSync(resolve(ROOT, "logs/trader.log"), line); } catch { /* logs dir missing */ }
  console.log(line.trim());
};

for (;;) {
  if (await isPortUp(PORT)) {
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
    continue;
  }

  const env = { ...process.env, ...loadEnv(resolve(ROOT, ".env")) };
  const logFd = openSync(resolve(ROOT, "logs/trader.log"), "a");
  boot(`port ${PORT} down — starting trader`);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/trader/src/index.ts"],
    { cwd: ROOT, env, stdio: ["ignore", logFd, logFd] },
  );
  const code = await new Promise((r) => child.once("exit", r));
  boot(`trader exited (code ${code})`);
  await new Promise((r) => setTimeout(r, 5_000)); // brief cooldown before recheck
}
