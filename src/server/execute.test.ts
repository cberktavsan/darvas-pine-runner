// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test";
import { syntheticCandles } from "../testing";
import { isServerRunRequest, type ServerRunRequest } from "./contract";
import { executeServerRun } from "./execute";

const candles = syntheticCandles(300);
const base = { candles, timeframe: "60", symbol: "BTCUSDT" };

describe("executeServerRun", () => {
  test("runs a script and returns its plots and inputs", async () => {
    const response = await executeServerRun({
      ...base,
      source: '//@version=5\nindicator("RSI")\nlen = input.int(14, "Length")\nplot(ta.rsi(close, len), "RSI")',
      inputs: { len: 7 },
    });
    if (!response.ok) throw new Error("expected a result");
    expect(response.result.title).toBe("RSI");
    expect(response.result.inputs[0]).toMatchObject({ varId: "len", value: 7 });
    expect(response.result.plots[0]?.points.length).toBe(300);
  });

  test("reports a script error with its position", async () => {
    const response = await executeServerRun({ ...base, source: '//@version=5\nindicator("X")\nplot(close $ 2)' });
    expect(response).toMatchObject({ ok: false, error: { line: 3 } });
  });

  test("asks for a series it lacks and uses it when the caller sends it", async () => {
    const source =
      '//@version=5\nindicator("HTF")\nd = request.security(syminfo.tickerid, "D", close)\nplot(d, "Daily")';
    const first = await executeServerRun({ ...base, source });
    if (first.ok || !("needs" in first)) throw new Error("expected needs");
    expect(first.needs[0]).toMatchObject({ symbol: "BTCUSDT" });

    const series = first.needs.map((need) => ({ ...need, candles: syntheticCandles(60, 86_400_000) }));
    const second = await executeServerRun({ ...base, source, series });
    if (!second.ok) throw new Error("expected a result");
    expect(second.result.plots[0]?.title).toBe("Daily");
  });

  test("accepts only well-formed requests", () => {
    const request: ServerRunRequest = { ...base, source: "plot(close)" };
    expect(isServerRunRequest(request)).toBe(true);
    expect(isServerRunRequest({ ...request, series: [{ symbol: "X", timeframe: "D", candles }] })).toBe(true);
    for (const bad of [null, { ...request, source: 1 }, { ...request, candles: {} }, { ...request, series: [{}] }]) {
      expect(isServerRunRequest(bad)).toBe(false);
    }
  });
});
