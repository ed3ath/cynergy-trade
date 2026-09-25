/** Date-bounded accounting reports. Wallet marks are context, not realized PnL. */
import type { PortfolioSnapshot, Position, TradeMode } from "@autonomous-trader/shared";

export interface ReportQuery {
  date: string; // YYYY-MM-DD, UTC; [00:00, next 00:00)
  mode: TradeMode;
  chains?: readonly string[];
  strategyId?: string;
  accountingVersion?: number;
}

interface ReportCohortKey {
  mode: TradeMode;
  chain: string;
  strategyId: string;
  /** Missing or version 1 is legacy, never silently upgraded. */
  accountingVersion?: number;
  /** Missing evidence is unknown, not verified. Empty means no recorded flags. */
  dataQuality?: readonly string[];
}

/** Structural subset of journal.getAccountingFills(), including BUY fees. */
export interface ReportFill extends ReportCohortKey {
  orderId: string;
  positionId: string | null;
  side: "BUY" | "SELL";
  confirmedAt: Date | string | null;
  realizedPnlDeltaUsd: number | null;
  realizedGrossPnlDeltaUsd: number | null;
  allocatedEntryFeeUsd: number | null;
  feeUsd: number;
}

/** One row per completed position; PnL covers ALL its fills, not just the final exit. */
export interface ReportCompletedPosition extends ReportCohortKey {
  id: string;
  closedAt: Date | string | null;
  /** Version 2: cumulative trading NET. Legacy: unreconciled recorded value. */
  pnlUsd: number | null;
  realizedGrossPnlUsd?: number | null;
  totalFeesUsd?: number | null;
}

export interface ReportCoverage {
  source: "durable" | "session-only";
  complete: boolean;
  issues?: readonly string[];
  /** Book-wide counts supplied by recovery, including positions not closed today. */
  legacyPositions?: number;
  unreconciledPositions?: number;
}

export interface ReportAiCost {
  day: string;
  estimatedCostUsd: number | null;
  /** Includes usage, pricing AND historical/query-scope coverage, not a billing guarantee. */
  complete: boolean;
  usageComplete?: boolean;
  pricingComplete?: boolean;
  issues?: readonly string[];
}

export interface DailyReportData {
  fills: readonly ReportFill[];
  completedPositions: readonly ReportCompletedPosition[];
  coverage: ReportCoverage;
  aiCost?: ReportAiCost;
  /** Only supply actual period-boundary values; never infer them from current equity. */
  equity?: { startUsd: number | null; endUsd: number | null };
}

/** Main supplies a journal adapter; the reporter never connects to a DB or mutates it. */
export interface ReportDataSource {
  readReportData(query: ReportQuery): DailyReportData | Promise<DailyReportData>;
}

export interface DailyReportInput extends ReportQuery {
  data: DailyReportData;
  /** Optional CURRENT context, not necessarily marks from the reported date. */
  portfolio?: PortfolioSnapshot;
  openPositions?: readonly Position[];
  generatedAt?: Date;
}

interface OutcomeStats {
  trades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  expectancyUsd: number;
  profitFactor: number | null;
  largestWinUsd: number;
  largestLossUsd: number;
}

export interface ReportEvaluation {
  status: "insufficient-samples" | "incomplete-accounting" | "cost-caution" | "not-validated" | "cohort-only";
  minimumCompletedPositions: 100;
  profitFactorReference: 1.3;
  reasons: string[];
  livePromotion: false;
}

export interface ReportCohort extends OutcomeStats {
  mode: TradeMode;
  chain: string;
  strategyId: string;
  accountingVersion: number;
  accounting: "reconciled" | "legacy" | "incomplete";
  realizations: number;
  grossPnlUsd: number | null;
  netPnlUsd: number | null;
  totalFeesUsd: number | null;
  /** Recorded lifetime outcomes of positions closed on this date; NOT daily realization. */
  recordedCompletedPnlUsd: number | null;
  unknownOutcomes: number;
  unverifiedPositions: number;
  /** Sizing multipliers are not daily report statistics. Retained as an explicit N/A. */
  performanceMultiplier: null;
  evaluation: ReportEvaluation;
}

export interface DailyReport extends OutcomeStats {
  date: string;
  mode: TradeMode;
  scope: { from: string; to: string; chains: readonly string[]; strategyId: string | null; accountingVersion: number | null };
  portfolioStartUsd: number | null;
  portfolioEndUsd: number | null;
  currentPortfolioUsd: number | null;
  portfolioContextAt: string | null;
  /** Known v2 SELL realizations on this UTC date, including partial exits. */
  grossPnlUsd: number;
  /** Trading net AFTER allocated entry and exit fees. Slippage is already in fills. */
  netPnlUsd: number;
  /** Fees allocated to these realizations, not necessarily paid on this date. */
  totalFeesUsd: number;
  /** All known transaction fees PAID on this date, including BUY fees. */
  transactionFeesPaidUsd: number;
  feeModel: "simulated" | "reported";
  realizations: number;
  entries: number;
  /** trades counts ALL completed positions; win/loss/expectancy use reconciledTrades. */
  reconciledTrades: number;
  completedPositionsNetPnlUsd: number;
  /** Mixed recorded values, explicitly NOT an audited net or comparable cohort. */
  allRecordedCompletedPnlUsd: number | null;
  unknownOutcomes: number;
  legacy: OutcomeStats & { recordedPnlUsd: number | null; unknownOutcomes: number };
  coverage: ReportCoverage & { issues: string[]; invalidRecords: number; unverifiedPositions: number };
  aiCost: ReportAiCost;
  netAfterAiCostUsd: number | null;
  openPositions: number | null;
  unrealizedPnlUsd: number | null;
  openPnlUsd: number | null;
  currentDrawdownPct: number | null;
  cohorts: ReportCohort[];
  /** Compatibility field, now daily mode/chain/strategy/version cohorts, not lifetime stats. */
  strategies: ReportCohort[];
  evaluation: ReportEvaluation;
  generatedAt: string;
}

/** Session fallback only. Reading a different day MUST NOT clear confirmed activity. */
export class ReportTracker implements ReportDataSource {
  private readonly fills = new Map<string, ReportFill>();
  private readonly completed = new Map<string, ReportCompletedPosition>();

  recordFill(fill: ReportFill): void {
    this.fills.set(JSON.stringify([fill.mode, fill.chain, fill.orderId]), structuredClone(fill));
  }

  recordCompletedPosition(position: ReportCompletedPosition): void {
    this.completed.set(JSON.stringify([position.mode, position.chain, position.id]), structuredClone(position));
  }

  readReportData(query: ReportQuery): DailyReportData {
    const { from, to } = utcReportWindow(query.date);
    const matches = (row: ReportCohortKey, at: Date | string | null): boolean => {
      const ms = at === null ? NaN : new Date(at).getTime();
      return inScope(row, query) && ms >= from.getTime() && ms < to.getTime();
    };
    return {
      fills: structuredClone([...this.fills.values()].filter((r) => matches(r, r.confirmedAt))),
      completedPositions: structuredClone([...this.completed.values()].filter((r) => matches(r, r.closedAt))),
      coverage: { source: "session-only", complete: false, issues: ["No durable journal: session-only history is incomplete across restarts."] },
    };
  }
}

export function buildDailyReport(input: DailyReportInput): DailyReport {
  const { data } = input;
  const { from, to } = utcReportWindow(input.date);
  const issues = [...(data.coverage.issues ?? [])];
  let invalidRecords = 0;
  // Defend against an accidentally unbounded source and duplicate join/session rows.
  const select = <T extends ReportCohortKey>(rows: readonly T[], id: (r: T) => string, at: (r: T) => Date | string | null): T[] => {
    const seen = new Map<string, T>();
    for (const row of rows) {
      if (!inScope(row, input)) continue;
      const time = at(row);
      const ms = time === null ? NaN : new Date(time).getTime();
      if (!Number.isFinite(ms)) {
        invalidRecords++;
        issues.push("A record has no valid confirmation/close timestamp; date coverage is incomplete.");
        continue;
      }
      if (ms < from.getTime() || ms >= to.getTime()) continue;
      const key = JSON.stringify([row.mode, row.chain, id(row)]);
      const prior = seen.get(key);
      const serialize = (value: T) => JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v);
      if (prior && serialize(prior) !== serialize(row)) {
        invalidRecords++;
        issues.push("Conflicting duplicate accounting records require reconciliation.");
      }
      if (!prior) seen.set(key, row);
    }
    return [...seen.values()];
  };
  const fills = select(data.fills, (r) => r.orderId, (r) => r.confirmedAt);
  const closed = select(data.completedPositions, (r) => r.id, (r) => r.closedAt);
  const sells = fills.filter((r) => r.side === "SELL");
  const reconciledFills = sells.filter((r) => r.accountingVersion === 2 && reconciles(r.realizedGrossPnlDeltaUsd, r.realizedPnlDeltaUsd, realizationFees(r)));
  const reconciledClosed = closed.filter((r) => r.accountingVersion === 2 && reconciles(r.realizedGrossPnlUsd, r.pnlUsd, r.totalFeesUsd));
  const legacyClosed = closed.filter((r) => r.accountingVersion !== 2);
  const invalidFinancial = sells.filter((r) => r.accountingVersion === 2 && !reconciledFills.includes(r)).length
    + closed.filter((r) => r.accountingVersion === 2 && !reconciledClosed.includes(r)).length
    + fills.filter((r) => !Number.isFinite(r.feeUsd) || r.feeUsd < 0).length;
  invalidRecords += invalidFinancial;
  if (invalidFinancial > 0) issues.push("Non-finite, missing or inconsistent accounting values remain visible but are not claimed as reconciled net.");
  if (data.coverage.source === "session-only") issues.push("Session-only history is incomplete across restarts.");
  if (legacyClosed.length || fills.some((r) => r.accountingVersion !== 2) || data.coverage.legacyPositions) {
    issues.push("Legacy/unreconciled activity is retained separately; its recorded PnL is not corrected fill-net.");
  }
  if (data.coverage.unreconciledPositions) issues.push("The book contains unreconciled positions.");
  const complete = data.coverage.complete && data.coverage.source === "durable" && invalidRecords === 0
    && legacyClosed.length === 0 && fills.every((r) => r.accountingVersion === 2)
    && !data.coverage.legacyPositions && !data.coverage.unreconciledPositions;
  const unverifiedCount = (fs: readonly ReportFill[], cs: readonly ReportCompletedPosition[]): number => {
    const ids = new Set<string>();
    for (const row of [...fs, ...cs]) {
      if (!row.dataQuality || row.dataQuality.length) {
        const id = "orderId" in row ? row.positionId ?? row.orderId : row.id;
        ids.add(JSON.stringify([row.mode, row.chain, id]));
      }
    }
    return ids.size;
  };
  const unverifiedPositions = unverifiedCount(fills, closed);
  if (unverifiedPositions) issues.push("Unverified/unknown data-quality observations are included, not filtered out of losses.");

  const grouped = new Map<string, ReportCohortKey>();
  for (const row of [...fills, ...closed]) grouped.set(cohortKey(row), row);
  const cohorts: ReportCohort[] = [...grouped.entries()].map(([key, row]) => {
    const cf = sells.filter((r) => cohortKey(r) === key);
    const cc = closed.filter((r) => cohortKey(r) === key);
    const rf = reconciledFills.filter((r) => cohortKey(r) === key);
    const rc = reconciledClosed.filter((r) => cohortKey(r) === key);
    const recorded = cc.filter((r) => finite(r.pnlUsd));
    const legacy = row.accountingVersion !== 2;
    const stats = outcomeStats(recorded.map((r) => r.pnlUsd as number));
    const accounting = legacy ? "legacy" : rf.length !== cf.length || rc.length !== cc.length ? "incomplete" : "reconciled";
    const qualityCount = unverifiedCount(fills.filter((r) => cohortKey(r) === key), cc);
    const reasons = [
      "Completed-position net expectancy and profit factor include trading costs, not allocated AI operating costs.",
      "Simulated/estimated costs are sensitive to assumptions; this is not statistical proof or LIVE readiness.",
      "Drawdown over a complete forward cohort must be checked separately against configured limits.",
    ];
    if (cc.length < 100) reasons.unshift("Fewer than 100 completed positions in this date/mode/chain/strategy/accounting-version cohort.");
    if (legacy || accounting !== "reconciled" || !complete) reasons.push("Accounting or report coverage is incomplete.");
    if (qualityCount) reasons.push("Includes tolerated-unverified or unknown observations.");
    if (stats.profitFactor === null) reasons.push("Profit factor is undefined without observed losses; it is not infinity or a pass.");
    if (stats.expectancyUsd <= 0 || (stats.profitFactor !== null && stats.profitFactor <= 1.3)) reasons.push("Positive after-cost expectancy and profit factor above 1.3 have not both been demonstrated.");
    return {
      ...stats,
      trades: cc.length,
      mode: row.mode, chain: row.chain, strategyId: row.strategyId, accountingVersion: row.accountingVersion ?? 1,
      accounting,
      realizations: cf.length,
      grossPnlUsd: legacy ? null : sum(rf, (r) => r.realizedGrossPnlDeltaUsd),
      netPnlUsd: legacy ? null : sum(rf, (r) => r.realizedPnlDeltaUsd),
      totalFeesUsd: legacy ? null : sum(rf, realizationFees),
      recordedCompletedPnlUsd: cc.length && !recorded.length ? null : sum(recorded, (r) => r.pnlUsd),
      unknownOutcomes: cc.length - recorded.length,
      unverifiedPositions: qualityCount,
      performanceMultiplier: null,
      evaluation: {
        status: cc.length < 100 ? "insufficient-samples" : accounting !== "reconciled" || !complete ? "incomplete-accounting"
          : stats.expectancyUsd <= 0 || stats.profitFactor === null || stats.profitFactor <= 1.3 ? "cost-caution" : "not-validated",
        minimumCompletedPositions: 100, profitFactorReference: 1.3, reasons, livePromotion: false,
      },
    };
  });
  cohorts.sort((a, b) => cohortKey(a).localeCompare(cohortKey(b)));

  const ai = data.aiCost;
  const aiIssues = [...(ai?.issues ?? [])];
  if (!ai) aiIssues.push("AI usage/pricing history is unavailable; missing cost is not zero.");
  if (ai && ai.day !== input.date) aiIssues.push("AI cost belongs to a different UTC date.");
  const estimatedCostUsd = ai?.day === input.date && finite(ai.estimatedCostUsd) && ai.estimatedCostUsd >= 0 ? ai.estimatedCostUsd : null;
  const aiCost: ReportAiCost = {
    ...ai,
    day: input.date,
    estimatedCostUsd,
    complete: ai?.complete === true && estimatedCostUsd !== null && ai.usageComplete !== false && ai.pricingComplete !== false,
    issues: aiIssues,
  };
  if (!aiCost.complete) aiIssues.push("AI usage, pricing or history coverage is incomplete; the estimate is not a billing ceiling.");
  const netPnlUsd = sum(reconciledFills, (r) => r.realizedPnlDeltaUsd);
  const contextPositions = input.openPositions?.filter((p) => inScope(p, input));
  const openPnlUsd = contextPositions && contextPositions.every((p) => finite(p.unrealizedPnlUsd))
    ? sum(contextPositions, (p) => p.unrealizedPnlUsd) : null;
  const legacyValues = legacyClosed.filter((r) => finite(r.pnlUsd));
  const recordedClosed = closed.filter((r) => finite(r.pnlUsd));
  const stats = outcomeStats(reconciledClosed.map((r) => r.pnlUsd as number));
  return {
    ...stats,
    date: input.date, mode: input.mode,
    scope: { from: from.toISOString(), to: to.toISOString(), chains: input.chains ?? [...new Set([...fills, ...closed].map((r) => r.chain))].sort(), strategyId: input.strategyId ?? null, accountingVersion: input.accountingVersion ?? null },
    portfolioStartUsd: finite(data.equity?.startUsd) ? data.equity.startUsd : null,
    portfolioEndUsd: finite(data.equity?.endUsd) ? data.equity.endUsd : null,
    currentPortfolioUsd: finite(input.portfolio?.totalValueUsd) ? input.portfolio.totalValueUsd : null,
    portfolioContextAt: input.portfolio?.snapshotAt.toISOString() ?? null,
    grossPnlUsd: sum(reconciledFills, (r) => r.realizedGrossPnlDeltaUsd),
    netPnlUsd,
    totalFeesUsd: sum(reconciledFills, realizationFees),
    transactionFeesPaidUsd: sum(fills.filter((r) => finite(r.feeUsd) && r.feeUsd >= 0), (r) => r.feeUsd),
    feeModel: input.mode === "PAPER" ? "simulated" : "reported",
    realizations: sells.length,
    entries: fills.filter((r) => r.side === "BUY").length,
    trades: closed.length,
    reconciledTrades: reconciledClosed.length,
    completedPositionsNetPnlUsd: sum(reconciledClosed, (r) => r.pnlUsd),
    allRecordedCompletedPnlUsd: closed.length && !recordedClosed.length ? null : sum(recordedClosed, (r) => r.pnlUsd),
    unknownOutcomes: closed.length - recordedClosed.length,
    legacy: { ...outcomeStats(legacyValues.map((r) => r.pnlUsd as number)), trades: legacyClosed.length, recordedPnlUsd: legacyClosed.length && !legacyValues.length ? null : sum(legacyValues, (r) => r.pnlUsd), unknownOutcomes: legacyClosed.length - legacyValues.length },
    coverage: { ...data.coverage, complete, issues: [...new Set(issues)], invalidRecords, unverifiedPositions },
    aiCost,
    netAfterAiCostUsd: complete && aiCost.complete && estimatedCostUsd !== null ? netPnlUsd - estimatedCostUsd : null,
    openPositions: contextPositions?.length ?? null,
    unrealizedPnlUsd: openPnlUsd,
    openPnlUsd,
    currentDrawdownPct: finite(input.portfolio?.currentDrawdownPct) ? input.portfolio.currentDrawdownPct : null,
    cohorts, strategies: cohorts,
    evaluation: cohorts.length === 1 ? cohorts[0]!.evaluation : {
      status: cohorts.every((c) => c.trades < 100) ? "insufficient-samples" : "cohort-only",
      minimumCompletedPositions: 100, profitFactorReference: 1.3,
      reasons: ["Evaluate each mode/chain/strategy/accounting-version cohort separately; pooled sample size is not evidence.", "AI operating costs and complete forward drawdown need separate cost-sensitive evaluation."],
      livePromotion: false,
    },
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
  };
}

export function formatReportText(r: DailyReport): string {
  const money = (n: number | null) => n === null ? "unknown" : `${n >= 0 ? "+" : ""}${n.toFixed(6)}`;
  return [
    `Daily report ${r.date} UTC (${r.mode}; ${r.coverage.source}; ${r.coverage.complete ? "complete accounting" : "INCOMPLETE"})`,
    `Period equity: ${money(r.portfolioStartUsd)} -> ${money(r.portfolioEndUsd)} USD`,
    `Current wallet: ${money(r.currentPortfolioUsd)} USD (context at ${r.portfolioContextAt ?? "unknown"}, not day-end equity)`,
    `Known realized trading net: ${money(r.netPnlUsd)} (gross ${money(r.grossPnlUsd)}, allocated ${r.feeModel} fees ${money(r.totalFeesUsd)})`,
    `Transaction fees paid in period: ${money(r.transactionFeesPaidUsd)}; ${r.entries} entries, ${r.realizations} SELL realizations (partials included)`,
    `Completed positions: ${r.trades} total, ${r.reconciledTrades} reconciled (W${r.wins}/L${r.losses}/flat ${r.breakevens}); win rate ${(r.winRate * 100).toFixed(1)}%`,
    `Completed-position lifetime net: ${money(r.completedPositionsNetPnlUsd)}; expectancy ${money(r.expectancyUsd)}; PF ${r.profitFactor?.toFixed(2) ?? "undefined (no losses)"}`,
    `Legacy: ${r.legacy.trades} closes (${r.legacy.unknownOutcomes} unknown outcomes), known recorded PnL ${money(r.legacy.recordedPnlUsd)} (unreconciled); all known recorded closed PnL ${money(r.allRecordedCompletedPnlUsd)} (${r.unknownOutcomes} unknown; mixed, not audited net)`,
    `AI operating cost estimate: ${money(r.aiCost.estimatedCostUsd)} (${r.aiCost.complete ? "covered estimate" : "incomplete/unknown"}); net after AI estimate ${money(r.netAfterAiCostUsd)}; NOT deducted from wallet`,
    `Current open positions: ${r.openPositions ?? "unknown"}; open mark-to-market ${money(r.openPnlUsd)}; drawdown ${r.currentDrawdownPct?.toFixed(2) ?? "unknown"}%`,
    `Evaluation: ${r.evaluation.status}; >=100 completed positions per compatible cohort is a minimum, not proof. PF >1.3 and positive after-cost expectancy require cost/drawdown review. No LIVE promotion.`,
    ...r.coverage.issues.map((s) => `Coverage: ${s}`),
    ...(r.aiCost.issues ?? []).map((s) => `AI cost: ${s}`),
    ...r.cohorts.map((s) => `  ${s.mode}/${s.chain}/${s.strategyId}/v${s.accountingVersion} (${s.accounting}): ${s.trades} closes (${s.unknownOutcomes} unknown), recorded expectancy ${money(s.trades > 0 && s.unknownOutcomes === s.trades ? null : s.expectancyUsd)}, PF ${s.profitFactor?.toFixed(2) ?? "undefined"}; ${s.evaluation.status}`),
  ].join("\n");
}

export function utcReportWindow(date: string): { from: Date; to: Date } {
  const from = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(from.getTime()) || from.toISOString().slice(0, 10) !== date) {
    throw new Error("Report date must be a valid YYYY-MM-DD UTC date");
  }
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

export function previousUtcDate(now = new Date()): string {
  return new Date(utcReportWindow(now.toISOString().slice(0, 10)).from.getTime() - 86_400_000).toISOString().slice(0, 10);
}

function inScope(row: ReportCohortKey, query: ReportQuery): boolean {
  return row.mode === query.mode && (!query.chains || query.chains.includes(row.chain))
    && (query.strategyId === undefined || row.strategyId === query.strategyId)
    && (query.accountingVersion === undefined || (row.accountingVersion ?? 1) === query.accountingVersion);
}

function cohortKey(row: ReportCohortKey): string {
  return JSON.stringify([row.mode, row.chain, row.strategyId, row.accountingVersion ?? 1]);
}

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function realizationFees(row: ReportFill): number | null {
  return finite(row.allocatedEntryFeeUsd) && row.allocatedEntryFeeUsd >= 0 && finite(row.feeUsd) && row.feeUsd >= 0
    ? row.allocatedEntryFeeUsd + row.feeUsd : null;
}

function reconciles(gross: number | null | undefined, net: number | null | undefined, fees: number | null | undefined): boolean {
  return finite(gross) && finite(net) && finite(fees) && fees >= 0 && Math.abs(gross - fees - net) <= 1e-8;
}

function sum<T>(rows: readonly T[], value: (row: T) => number | null): number {
  return rows.reduce((total, row) => total + (value(row) ?? 0), 0);
}

function outcomeStats(values: readonly number[]): OutcomeStats {
  const wins = values.filter((n) => n > 0);
  const losses = values.filter((n) => n < 0);
  const sumWins = wins.reduce((s, n) => s + n, 0);
  const sumLosses = losses.reduce((s, n) => s + n, 0);
  return {
    trades: values.length, wins: wins.length, losses: losses.length, breakevens: values.length - wins.length - losses.length,
    winRate: values.length ? wins.length / values.length : 0,
    expectancyUsd: values.length ? (sumWins + sumLosses) / values.length : 0,
    profitFactor: sumLosses < 0 ? sumWins / -sumLosses : null,
    largestWinUsd: wins.reduce((m, n) => Math.max(m, n), 0),
    largestLossUsd: losses.reduce((m, n) => Math.min(m, n), 0),
  };
}
