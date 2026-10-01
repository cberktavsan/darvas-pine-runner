import { describe, expect, test } from "bun:test";
import { Indicator, PineTS } from "pinets";
import { upgradeLegacyPine } from "./legacy";
import { toPineTsCandles } from "./serialize";
import { syntheticCandles } from "./testing";

async function lastValues(source: string): Promise<Record<string, unknown>> {
  const pine = new PineTS(toPineTsCandles(syntheticCandles(120), "60"), "TEST", "60");
  const ctx = await pine.run(new Indicator(source));
  const plots = ctx.plots as Record<string, { data: { value: unknown }[] }>;
  return Object.fromEntries(
    Object.entries(plots)
      .filter(([key]) => !key.startsWith("__"))
      .map(([key, plot]) => [key, plot.data.at(-1)?.value]),
  );
}

describe("upgradeLegacyPine", () => {
  test("leaves v5 and v6 scripts untouched", () => {
    const source = '//@version=6\nindicator("x")\nplot(ta.sma(close, 5))';
    expect(upgradeLegacyPine(source)).toEqual({ source, fromVersion: null, lineOffset: 0 });
  });

  test("rewrites a v4 script and keeps strings and comments as written", () => {
    const upgraded = upgradeLegacyPine(`//@version=4
study("sma(close) demo", shorttitle="max", overlay=true, resolution="")
len = input(14, title="Length", type=input.integer, minval=1)
// rsi(close, len) stays in this comment
basis = sma(close, len)
dev = 2 * stdev(close, len)
upper = max(basis + dev, highest(high, len))
daily = security(syminfo.tickerid, "D", close)
plot(iff(close > basis, upper, basis), color=color.red, transp=70)
bgcolor(close > daily ? color.green : na, transp=90)
label.new(bar_index, high, tostring(obv), style=label.style_labeldown)`);

    expect(upgraded.fromVersion).toBe(4);
    expect(upgraded.lineOffset).toBe(0);
    expect(upgraded.source).toBe(`//@version=5
indicator("sma(close) demo", shorttitle="max", overlay=true, timeframe="")
len = input.int(14, title="Length", minval=1)
// rsi(close, len) stays in this comment
basis = ta.sma(close, len)
dev = 2 * ta.stdev(close, len)
upper = math.max(basis + dev, ta.highest(high, len))
daily = request.security(syminfo.tickerid, "D", close)
plot((close > basis ? upper : basis), color=color.new(color.red, 70))
bgcolor(color.new(close > daily ? color.green : na, 90))
label.new(bar_index, high, str.tostring(ta.obv), style=label.style_label_down)`);
  });

  test("rewrites v3 colours, styles, typed inputs and a variable named like a built-in", () => {
    const upgraded = upgradeLegacyPine(`//@version=3
study(title="RSI")
length = input(title="Length", type=integer, defval=14)
mode = input(title="Mode", defval="a", options=["a", "b"])
rsi = rsi(close, length)
plot(rsi, color=rsi > 70 ? red : #f4b77d, style=histogram, transp=0)
hline(50, linestyle=dotted, color=color(white, 100))`);

    expect(upgraded.fromVersion).toBe(3);
    expect(upgraded.source).toBe(`//@version=5
indicator(title="RSI")
length = input.int(title="Length", defval=14)
mode = input.string(title="Mode", defval="a", options=["a", "b"])
rsi = ta.rsi(close, length)
plot(rsi, color=color.new(rsi > 70 ? color.red : #f4b77d, 0), style=plot.style_histogram)
hline(50, linestyle=hline.style_dotted, color=color.new(color.white, 100))`);
  });

  test("does not rename built-ins the script redefines", () => {
    const upgraded = upgradeLegacyPine(`//@version=4
study("x")
sum(a, period) => a + period
tr = high - low
plot(sum(tr, 1))`);
    expect(upgraded.source).toContain("plot(sum(tr, 1))");
    expect(upgraded.source).not.toContain("ta.tr");
    expect(upgraded.source).not.toContain("math.sum");
  });

  test("adds a version line to a script without one and reports the shift", () => {
    const upgraded = upgradeLegacyPine('study("old")\nplot(sma(close, 3))');
    expect(upgraded).toEqual({
      source: '//@version=5\nindicator("old")\nplot(ta.sma(close, 3))',
      fromVersion: 1,
      lineOffset: 1,
    });
  });

  test("an upgraded v3 script computes the same values as its v6 form", async () => {
    const legacy = upgradeLegacyPine(`//@version=3
study("legacy")
len = input(14, type=integer)
plot(rsi(close, len), title="RSI", color=red)
plot(sma(close, len) - ema(close, len), title="Spread")
plot(highest(high, len) - lowest(low, len), title="Range")`);
    const modern = `//@version=6
indicator("modern")
len = input.int(14)
plot(ta.rsi(close, len), title="RSI")
plot(ta.sma(close, len) - ta.ema(close, len), title="Spread")
plot(ta.highest(high, len) - ta.lowest(low, len), title="Range")`;

    const expected = await lastValues(modern);
    expect(expected.RSI).toBeNumber();
    expect(await lastValues(legacy.source)).toEqual(expected);
  });
});
