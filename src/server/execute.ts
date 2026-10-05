// SPDX-License-Identifier: AGPL-3.0-only
// Runs one server request with the series it carries and reports the ones it lacks.
import type { FetchCandles } from "../provider";
import { runPine } from "../run";
import { seriesKey, type SeriesQuery, type ServerRunRequest, type ServerRunResponse } from "./contract";

export async function executeServerRun(request: ServerRunRequest): Promise<ServerRunResponse> {
  const carried = new Map((request.series ?? []).map((item) => [seriesKey(item), item.candles]));
  const needs: SeriesQuery[] = [];
  const fetchCandles: FetchCandles = async (query) => {
    const candles = carried.get(seriesKey(query));
    if (candles) return candles;
    needs.push(query);
    throw new Error(`request.security: no data (${query.symbol}, ${query.timeframe})`);
  };

  const reply = await runPine(
    {
      type: "pine-runner:run",
      id: "server",
      source: request.source,
      candles: request.candles,
      timeframe: request.timeframe,
      ...(request.symbol === undefined ? {} : { symbol: request.symbol }),
      ...(request.inputs === undefined ? {} : { inputs: request.inputs }),
    },
    fetchCandles,
  );
  // A run that lacked a series is not a script error: the caller fetches it and tries again.
  if (needs.length > 0) return { ok: false, needs };
  if (reply.ok && reply.result) return { ok: true, result: reply.result };
  return { ok: false, error: reply.error ?? { message: "The script did not run" } };
}
