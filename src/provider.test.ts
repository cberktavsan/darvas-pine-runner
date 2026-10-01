import { describe, expect, test } from "bun:test";
import { Indicator, PineTS } from "pinets";
import type { RunRequest } from "./protocol";
import { createProvider, inferMintick } from "./provider";
import { HOUR_MS, START_MS, syntheticCandles } from "./testing";

const DAY_MS = 24 * HOUR_MS;

function request(source: string): RunRequest {
  return {
    type: "pine-runner:run",
    id: "run-1",
    source,
    candles: syntheticCandles(24 * 6),
    timeframe: "60",
    symbol: "BTC-USDT-SWAP",
  };
}

describe("createProvider", () => {
  test("serves the chart series itself and exposes syminfo", async () => {
    const calls: unknown[] = [];
    const run = request(`//@version=6
indicator("info")
same = request.security(syminfo.tickerid, timeframe.period, close)
plot(same - close, "diff")
plot(syminfo.mintick, "tick")`);
    const { provider } = createProvider(run, async (query) => {
      calls.push(query);
      throw new Error("the chart series must not be requested from the embedder");
    });
    const ctx = await new PineTS(provider, run.symbol, run.timeframe).run(new Indicator(run.source));
    const plots = ctx.plots as Record<string, { data: { value: number }[] }>;

    expect(calls).toEqual([]);
    expect(plots.diff?.data.at(-1)?.value).toBe(0);
    expect(plots.tick?.data.at(-1)?.value).toBeGreaterThan(0);
  });

  test("asks the embedder for another timeframe once and aligns it to the chart", async () => {
    const calls: { symbol: string; timeframe: string }[] = [];
    const daily = syntheticCandles(8, DAY_MS);
    daily.time = daily.time.map((_, index) => START_MS - DAY_MS + index * DAY_MS);
    const run = request(`//@version=6
indicator("htf", overlay=true)
d = request.security(syminfo.tickerid, "D", close)
again = request.security(syminfo.tickerid, "D", close)
plot(d, "daily")
plot(again, "again")`);
    const { provider } = createProvider(run, async (query) => {
      calls.push({ symbol: query.symbol, timeframe: query.timeframe });
      return daily;
    });
    const ctx = await new PineTS(provider, run.symbol, run.timeframe).run(new Indicator(run.source));
    const plots = ctx.plots as Record<string, { data: { value: number }[] }>;
    const values = plots.daily!.data.map((point) => point.value).filter(Number.isFinite);

    expect(calls).toEqual([{ symbol: "BTC-USDT-SWAP", timeframe: "D" }]);
    expect(values.length).toBeGreaterThan(0);
    // Every value the script saw is a close of the daily series the embedder returned.
    expect(values.every((value) => daily.close.includes(value))).toBe(true);
    expect(plots.again!.data.at(-1)?.value).toBe(plots.daily!.data.at(-1)!.value);
  });

  test("records an embedder failure and still lets the run finish", async () => {
    const run = request(`//@version=6
indicator("missing")
plot(request.security("DXY", "D", close), "dxy")
plot(close, "close")`);
    const { provider, failures } = createProvider(run, async () => {
      throw new Error("request.security: symbol not available (DXY, D)");
    });
    // A rejected data source would leave PineTS waiting forever; the run has to return.
    await new PineTS(provider, run.symbol, run.timeframe).run(new Indicator(run.source)).catch(
      () => null, // The script may also fail on the empty series; `failures` carries the cause.
    );
    expect(failures).toEqual(["request.security: symbol not available (DXY, D)"]);
  });
});

describe("inferMintick", () => {
  test("uses the finest decimal step in the closes", () => {
    expect(inferMintick([100, 100.5, 100.25])).toBe(0.01);
    expect(inferMintick([61709, 61710])).toBe(1);
    expect(inferMintick([0.00001234])).toBeCloseTo(1e-8, 12);
  });
});
