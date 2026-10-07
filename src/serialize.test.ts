import { describe, expect, test } from "bun:test";
import { Indicator, PineTS } from "pinets";
import { applyInputs, serializeContext, toPineTsCandles, toRunError } from "./serialize";
import { syntheticCandles as candles } from "./testing";

async function runScript(source: string, count = 80) {
  const indicator = new Indicator(source);
  const pine = new PineTS(toPineTsCandles(candles(count), "60"), "TEST", "60");
  const ctx = await pine.run(indicator);
  return serializeContext(ctx, indicator, { durationMs: 1, upgradedFromVersion: null });
}

describe("toPineTsCandles", () => {
  test("derives closeTime from the next bar and the timeframe for the last bar", () => {
    const rows = toPineTsCandles(candles(2), "60");
    expect(rows[0]?.closeTime).toBe(rows[1]!.openTime - 1);
    expect(rows[1]?.closeTime).toBe(rows[1]!.openTime + 3_600_000 - 1);
  });
});

describe("serializeContext", () => {
  test("names the missing declaration when a script never calls indicator()", async () => {
    // TradingView's built-in ribbon pasted with its indicator() line commented out.
    await expect(
      runScript(`
//@version=6
//indicator("Moving Average Ribbon", overlay = true)
plot(ta.sma(close, 20), "MA")
`),
    ).rejects.toThrow("The script has no indicator() declaration");
  });

  test("keeps plots, hlines, fills and shapes with their styles", async () => {
    const result = await runScript(`
//@version=6
indicator("RSI test", shorttitle="RT", overlay=false)
len = input.int(14, "Length", minval=1)
r = ta.rsi(close, len)
p1 = plot(r, "RSI", color=color.purple, linewidth=2)
p2 = plot(ta.sma(r, 5), "Signal", style=plot.style_stepline)
fill(p1, p2, color=color.new(color.blue, 90))
hline(70, "OB", color=color.gray, linestyle=hline.style_dashed)
plotshape(ta.crossover(r, 30), "Buy", style=shape.triangleup, location=location.belowbar, color=color.green)
bgcolor(r > 70 ? color.new(color.red, 85) : na)
`);
    expect(result.title).toBe("RSI test");
    expect(result.shortTitle).toBe("RT");
    expect(result.overlay).toBe(false);
    expect(result.inputs).toEqual([
      expect.objectContaining({
        varId: "len",
        title: "Length",
        type: "int",
        defval: 14,
        value: 14,
        minval: 1,
      }),
    ]);
    const byKey = Object.fromEntries(result.plots.map((plot) => [plot.key, plot]));
    expect(byKey.RSI?.style).toBe("line");
    expect(byKey.RSI?.options).toMatchObject({ color: "#9C27B0", linewidth: 2 });
    expect(byKey.RSI?.points.at(-1)?.value).toBeNumber();
    expect(byKey.Signal?.style).toBe("style_stepline");
    expect(byKey.fill?.style).toBe("fill");
    expect(byKey.fill?.options).toMatchObject({ plot1: "RSI", plot2: "Signal" });
    expect(byKey.OB?.style).toBe("hline");
    expect(byKey.OB?.points.at(-1)?.value).toBe(70);
    expect(byKey.Buy?.style).toBe("shape");
    expect(byKey.Buy?.options).toMatchObject({ shape: "shape_triangle_up", location: "BelowBar" });
    expect(byKey.plot?.style).toBe("background");
    expect(result.plots.some((plot) => plot.key.startsWith("__"))).toBe(false);
  });

  test("returns the final state of labels, lines and boxes without deleted objects", async () => {
    const result = await runScript(`
//@version=6
indicator("Drawings", overlay=true)
var label old = na
if barstate.islast
    old := label.new(bar_index, high, "gone")
    label.delete(old)
    label.new(bar_index, low, "kept")
    line.new(bar_index - 5, low, bar_index, high, color=color.red, width=2)
    box.new(bar_index - 3, high, bar_index, low, text="b")
plot(close)
`);
    expect(result.labels.map((label) => label.text)).toEqual(["kept"]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ x1: 74, x2: 79, width: 2, xloc: "bi" });
    expect(result.upgradedFromVersion).toBeNull();
    expect(result.boxes[0]).toMatchObject({ left: 76, right: 79, text: "b" });
  });

  test("turns NaN values into null points", async () => {
    const result = await runScript(`
//@version=6
indicator("NaN")
plot(ta.sma(close, 50), "SMA")
`);
    const sma = result.plots.find((plot) => plot.key === "SMA");
    expect(sma?.points[0]?.value).toBeNull();
    expect(sma?.points.at(-1)?.value).toBeNumber();
  });
});

describe("applyInputs", () => {
  const source = `//@version=6
indicator("inputs")
len = input.int(14, "Length", minval=2, maxval=50)
mode = input.string("EMA", "Mode", options=["EMA", "SMA"])
src = input.source(close, "Source")
plot(ta.sma(src, len) + input.int(5, "Inline"), "v")`;

  test("applies valid overrides and reports the value each input used", async () => {
    const indicator = new Indicator(source);
    const skipped = applyInputs(indicator, { len: 7, mode: "SMA", src: "high", in_3: 9 });
    const pine = new PineTS(toPineTsCandles(candles(40), "60"), "TEST", "60");
    const result = serializeContext(await pine.run(indicator), indicator, {
      durationMs: 1,
      upgradedFromVersion: null,
      inputWarnings: skipped,
    });

    expect(skipped).toEqual([]);
    expect(result.inputs.map((input) => [input.varId || input.id, input.defval, input.value])).toEqual([
      ["len", 14, 7],
      ["mode", "EMA", "SMA"],
      ["src", "close", "high"],
      ["in_3", 5, 9],
    ]);
  });

  test("skips stale keys and rejected values without failing the run", () => {
    const indicator = new Indicator(source);
    const skipped = applyInputs(indicator, { removed: 1, len: 999, mode: "XXX", src: "low" });

    expect(skipped).toHaveLength(3);
    expect(skipped[0]).toContain('input "removed" ignored');
    expect(skipped[1]).toContain("above maxval 50");
    expect(indicator.input.len).toBe(14);
    expect(indicator.input.src).toBe("low");
  });
});

describe("toRunError", () => {
  test("extracts line and column from lexer messages", () => {
    expect(toRunError(new Error("Unexpected character '$' at 3:7"))).toEqual({
      message: "Unexpected character '$' at 3:7",
      line: 3,
      column: 7,
    });
  });

  test("passes other messages through", () => {
    expect(toRunError("boom")).toEqual({ message: "boom" });
  });

  test("subtracts lines the runner added above the source", () => {
    expect(toRunError(new Error("Unterminated string at 4:2"), 1)).toMatchObject({ line: 3 });
  });
});
