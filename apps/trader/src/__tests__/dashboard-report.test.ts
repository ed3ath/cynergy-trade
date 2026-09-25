import { readFileSync } from "node:fs";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildDailyReport } from "../report.js";

const html = readFileSync(new URL("../../public/dashboard.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("Dashboard script missing");

/** Minimal DOM fixture: render the actual page script with all I/O disabled. */
class Element {
  children: Array<Element | string> = [];
  attrs: Record<string, unknown> = {};
  style: Record<string, unknown> = {};
  dataset: Record<string, unknown> = {};
  hidden = false;
  classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: () => false };
  listeners = new Map<string, () => void>();
  private text = "";
  constructor(readonly tag: string, readonly namespaceURI = "http://www.w3.org/1999/xhtml", private readonly width = 1200) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return [this.text, ...this.children.map((c) => typeof c === "string" ? c : c.textContent)].join(" "); }
  append(...children: Array<Element | string>): void { this.children.push(...children); }
  replaceChildren(...children: Array<Element | string>): void { this.text = ""; this.children = children; }
  setAttribute(key: string, value: unknown): void { this.attrs[key] = value; }
  addEventListener(key: string, fn: () => void): void { this.listeners.set(key, fn); }
  getBoundingClientRect() { return { width: this.width, height: 200 }; }
}

function page(width = 1200) {
  const nodes = new Map<string, Element>();
  const element = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element("div", undefined, width));
    return nodes.get(id)!;
  };
  const noNetwork = vi.fn(() => new Promise(() => { /* network deliberately never started */ }));
  const context = createContext({
    document: {
      getElementById: element,
      createElement: (tag: string) => new Element(tag),
      createElementNS: (ns: string, tag: string) => new Element(tag, ns),
      querySelectorAll: () => [],
      body: new Element("body"), documentElement: new Element("html"),
    },
    window: {}, localStorage: { getItem: () => null, setItem: vi.fn() },
    fetch: noNetwork, EventSource: class {}, setInterval: vi.fn(), addEventListener: vi.fn(),
    getComputedStyle: () => ({ getPropertyValue: () => "#111" }), location: { protocol: "http:" },
  });
  new Script(script!).runInContext(context);
  return {
    element,
    call(fn: string, value: unknown) { context["fixture"] = value; runInContext(`${fn}(fixture)`, context); },
  };
}

function status() {
  return {
    portfolio: { totalValueUsd: 100, availableCapitalUsd: 97, allocatedUsd: 3, dailyPnlUsd: -0.09, weeklyPnlUsd: -0.09, allTimePnlUsd: -0.09, currentDrawdownPct: 0.09, openPositions: 0 },
    emergency: { tradingMode: "PAPER", killSwitch: false, stopNewEntries: false },
    positions: [], regime: { current: "NEUTRAL" }, uptimeMs: 1, version: "fixture",
  };
}

describe("dashboard accounting labels", () => {
  it.each([390, 1280])("loads the real script and renders wallet/realized labels at %ipx without redesign", (width) => {
    const p = page(width);
    p.call("renderStatus", status());
    const tiles = p.element("tiles").textContent;
    expect(tiles).toContain("Wallet (paper)");
    expect(tiles).toContain("realized today UTC");
    expect(tiles).toContain("Realized (book)");
    expect(tiles).toContain("Advisory, not AI trades");
    expect(tiles).not.toContain("All-time PnL");
    expect(p.element("equity-title").textContent).toContain("wallet value (paper)");
    expect(html).toContain("Recent ~4h, not lifetime");
    expect(html).toContain('grid-template-areas:');
    expect(html).toContain('@media (max-width: 699px)');
  });

  it("renders older trade payloads with visible legacy warnings rather than dropping losses", () => {
    const p = page();
    p.call("renderTrades", [{ tokenAddress: "fixture-token", chain: "base", sizeUsd: 3, sizeTokens: "1", entryPrice: 3, pnlUsd: -0.09, pnlPct: -3, closedAt: "2026-09-24T12:00:00Z" }]);
    const text = p.element("trades").textContent;
    expect(text).toContain("up to 50 per chain, not lifetime");
    expect(text).toContain("legacy");
    expect(text).toContain("$-0.09");
  });

  it("keeps unknown legacy close PnL unknown instead of rendering it as a zero win", () => {
    const p = page();
    p.call("renderTrades", [{ tokenAddress: "fixture-token", sizeUsd: 3, entryPrice: 3, pnlUsd: null, pnlPct: null, accountingVersion: 1 }]);
    expect(p.element("trades").textContent).toContain("unknown");
    expect(p.element("trades").textContent).toContain("legacy");
    expect(p.element("trades").textContent).not.toContain("$0");
  });

  it("shows unverified accounting and open PnL distinctly from realized outcomes", () => {
    const p = page();
    p.call("renderStatus", { ...status(), positions: [{ tokenAddress: "fixture-token", mode: "PAPER", chain: "base", sizeUsd: 3, sizeTokens: "1", unrealizedPnlUsd: -0.1, unrealizedPnlPct: -3.3, openedAt: "2026-09-24T12:00:00Z", accountingVersion: 2, dataQuality: ["holders-unknown"] }] });
    expect(p.element("positions").textContent).toContain("Open PnL");
    expect(p.element("positions").textContent).toContain("v2 / unverified");
  });

  it("renders absent/older report fields safely until the host supplies coverage", () => {
    const p = page();
    p.call("renderReport", { date: "2026-09-24", trades: 0 });
    expect(p.element("report").textContent).toContain("missing history/cost is not zero");
  });

  it("shows exact fee estimates, incomplete coverage and unknown AI net in the existing Book pane", () => {
    const p = page();
    const r = buildDailyReport({
      date: "2026-09-24", mode: "PAPER",
      data: {
        fills: [{ orderId: "f1", positionId: "p1", mode: "PAPER", chain: "base", strategyId: "ai", accountingVersion: 2, side: "SELL", confirmedAt: "2026-09-24T12:00:00Z", realizedGrossPnlDeltaUsd: -0.089325, realizedPnlDeltaUsd: -0.090325, allocatedEntryFeeUsd: 0.0005, feeUsd: 0.0005 }],
        completedPositions: [], coverage: { source: "session-only", complete: false },
      },
    });
    p.call("renderReport", r);
    const text = p.element("report").textContent;
    expect(text).toContain("2026-09-24 UTC");
    expect(text).toContain("session-only / INCOMPLETE");
    expect(text).toContain("$-0.090325");
    expect(text).toContain("$0.0005");
    expect(text).toContain("AI operating cost estimate (outside wallet)");
    expect(text).toContain("unknown / incomplete/unknown");
    expect(text).toContain("Net after AI operating cost estimate unknown");
    expect(text).toContain("insufficient-samples");
    p.element("tab-report").listeners.get("click")!();
    expect(p.element("report").hidden).toBe(false);
    expect(p.element("positions").hidden).toBe(true);
  });
});
