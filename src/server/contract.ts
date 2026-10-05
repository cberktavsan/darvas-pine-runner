// SPDX-License-Identifier: AGPL-3.0-only
// HTTP contract of the server runner. The caller posts a script with candles and gets the same
// RunResult the browser runner returns.
import { isCandles, type RunError, type RunResult, type RunnerCandles, type ScalarInput } from "../protocol";

/** Another series the script read with `request.security`. */
export interface SeriesQuery {
  symbol: string;
  /** TradingView timeframe string, as in the run request. */
  timeframe: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface ServerRunRequest {
  source: string;
  candles: RunnerCandles;
  timeframe: string;
  symbol?: string;
  inputs?: Record<string, ScalarInput>;
  /** Series the caller already fetched, answering `needs` of an earlier attempt. */
  series?: (SeriesQuery & { candles: RunnerCandles })[];
}

/**
 * `needs` lists the series the script asked for that the request did not carry. The server
 * runner has no network, so the caller fetches them and posts the run again with `series`.
 */
export type ServerRunResponse =
  | { ok: true; result: RunResult }
  | { ok: false; error: RunError }
  | { ok: false; needs: SeriesQuery[] };

export const seriesKey = (query: SeriesQuery): string =>
  [query.symbol, query.timeframe, query.limit ?? "", query.from ?? "", query.to ?? ""].join("|");

export function isServerRunRequest(value: unknown): value is ServerRunRequest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  const series = m.series;
  return (
    typeof m.source === "string" &&
    typeof m.timeframe === "string" &&
    isCandles(m.candles) &&
    (series === undefined ||
      (Array.isArray(series) &&
        series.every(
          (item: unknown) =>
            !!item &&
            typeof item === "object" &&
            typeof (item as SeriesQuery).symbol === "string" &&
            typeof (item as SeriesQuery).timeframe === "string" &&
            isCandles((item as { candles?: unknown }).candles),
        )))
  );
}
