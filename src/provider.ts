// SPDX-License-Identifier: AGPL-3.0-only
// The data source PineTS reads from. The chart series comes from the run request; any other
// symbol or timeframe (`request.security`) is asked of the embedding page, because the runner
// itself has no network access.
import type { IProvider, ISymbolInfo, Kline } from "pinets";
import type { DataRequest, RunRequest, RunnerCandles } from "./protocol";
import { toPineTsCandles } from "./serialize";

const MAX_DATA_REQUESTS = 12;

export type FetchCandles = (
  request: Omit<DataRequest, "type" | "runId" | "requestId">,
) => Promise<RunnerCandles>;

const bareSymbol = (tickerId: string): string => tickerId.slice(tickerId.lastIndexOf(":") + 1);
const bareTimeframe = (timeframe: string): string => timeframe.replace(/^1(?=[DWM]$)/, "");

function toKlines(candles: RunnerCandles, timeframe: string): Kline[] {
  return toPineTsCandles(candles, timeframe).map((row) => ({
    ...row,
    quoteAssetVolume: 0,
    numberOfTrades: 0,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  }));
}

function inRange(rows: Kline[], limit?: number, from?: number, to?: number): Kline[] {
  const bounded = rows.filter(
    (row) => (from === undefined || row.openTime >= from) && (to === undefined || row.openTime <= to),
  );
  return limit ? bounded.slice(-limit) : bounded;
}

/** The smallest price step visible in the closes, for `syminfo.mintick`. */
export function inferMintick(closes: number[]): number {
  let decimals = 0;
  for (const close of closes.slice(-200)) {
    const fraction = close.toString().split(".")[1];
    if (fraction && !/e/i.test(close.toString())) decimals = Math.max(decimals, fraction.length);
  }
  return 10 ** -Math.min(decimals, 8);
}

function symbolInfo(symbol: string, mintick: number): ISymbolInfo {
  return {
    ticker: symbol, tickerid: symbol, prefix: "", root: symbol, description: symbol,
    type: "crypto", main_tickerid: symbol, current_contract: "", isin: "",
    basecurrency: "", currency: "", timezone: "Etc/UTC", country: "",
    mintick, pricescale: Math.round(1 / mintick), minmove: 1, pointvalue: 1, mincontract: 0,
    session: "24x7", volumetype: "base", expiration_date: 0,
    employees: 0, industry: "", sector: "", shareholders: 0,
    shares_outstanding_float: 0, shares_outstanding_total: 0,
    recommendations_buy: 0, recommendations_buy_strong: 0, recommendations_date: 0,
    recommendations_hold: 0, recommendations_sell: 0, recommendations_sell_strong: 0,
    recommendations_total: 0, target_price_average: 0, target_price_date: 0,
    target_price_estimates: 0, target_price_high: 0, target_price_low: 0, target_price_median: 0,
  };
}

export interface RunProvider {
  provider: IProvider;
  /** Messages of data requests the embedder could not serve. */
  failures: string[];
}

export function createProvider(request: RunRequest, fetchCandles: FetchCandles): RunProvider {
  const symbol = request.symbol ?? "UNKNOWN";
  const chart = toKlines(request.candles, request.timeframe);
  const mintick = inferMintick(request.candles.close);
  const fetched = new Map<string, Promise<Kline[]>>();
  const failures: string[] = [];
  // PineTS never settles a run whose data source rejects, so a failed request resolves to no
  // bars and the caller reports `failures` once the run returns.
  const failed = (message: string): Kline[] => {
    failures.push(message);
    return [];
  };

  const provider: IProvider = {
    configure() {},
    async getSymbolInfo(tickerId) {
      return symbolInfo(bareSymbol(tickerId) || symbol, mintick);
    },
    async getMarketData(tickerId, timeframe, limit, from, to) {
      const wanted = bareSymbol(tickerId) || symbol;
      if (wanted === symbol && bareTimeframe(timeframe) === bareTimeframe(request.timeframe)) {
        return inRange(chart, limit, from, to);
      }
      const key = `${wanted}|${timeframe}|${limit ?? ""}|${from ?? ""}|${to ?? ""}`;
      let pending = fetched.get(key);
      if (!pending) {
        if (fetched.size >= MAX_DATA_REQUESTS) {
          return failed(`request.security: more than ${MAX_DATA_REQUESTS} data requests in one run`);
        }
        const query = { symbol: wanted, timeframe, ...(limit ? { limit } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) };
        pending = fetchCandles(query).then(
          (candles) => toKlines(candles, timeframe),
          (error: unknown) => failed(error instanceof Error ? error.message : String(error)),
        );
        fetched.set(key, pending);
      }
      return pending;
    },
  };
  return { provider, failures };
}
