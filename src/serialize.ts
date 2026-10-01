// SPDX-License-Identifier: AGPL-3.0-only
import type { Context, Indicator } from "pinets";
import type { InputMeta, PlotPoint, PlotSeries, RunResult, RunnerCandles } from "./protocol";

const DRAWING_KEYS = {
  labels: "__labels__",
  lines: "__lines__",
  boxes: "__boxes__",
  tables: "__tables__",
} as const;
const HIDDEN_PLOT_KEYS = new Set([
  ...Object.values(DRAWING_KEYS),
  "__linefills__",
  "__polylines__",
]);

interface PineTsPoint {
  time: number;
  value: unknown;
  options?: { color?: unknown };
}

interface PineTsPlot {
  title?: string;
  options?: Record<string, unknown>;
  data?: PineTsPoint[];
}

export interface PineTsCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const TIMEFRAME_MS: Record<string, number> = {
  "1": 60_000, "3": 180_000, "5": 300_000, "15": 900_000, "30": 1_800_000, "45": 2_700_000,
  "60": 3_600_000, "120": 7_200_000, "180": 10_800_000, "240": 14_400_000,
  D: 86_400_000, W: 604_800_000, M: 30 * 86_400_000,
};

/** Rows for PineTS. closeTime is the next bar's open minus one millisecond, the TradingView convention. */
export function toPineTsCandles(candles: RunnerCandles, timeframe: string): PineTsCandle[] {
  const fallbackMs = TIMEFRAME_MS[timeframe] ?? 60_000;
  const rows: PineTsCandle[] = [];
  for (let i = 0; i < candles.time.length; i += 1) {
    const openTime = candles.time[i]!;
    const nextOpen = candles.time[i + 1] ?? openTime + fallbackMs;
    rows.push({
      openTime,
      closeTime: nextOpen - 1,
      open: candles.open[i]!,
      high: candles.high[i]!,
      low: candles.low[i]!,
      close: candles.close[i]!,
      volume: candles.volume[i]!,
    });
  }
  return rows;
}

function serializePoint(point: PineTsPoint): PlotPoint {
  const raw = point.value;
  let value: PlotPoint["value"] = null;
  if (typeof raw === "number") value = Number.isFinite(raw) ? raw : null;
  else if (typeof raw === "boolean") value = raw;
  else if (Array.isArray(raw)) value = raw.map((item) => (typeof item === "number" ? item : NaN));
  const color = point.options?.color;
  return typeof color === "string" && color.length > 0 ? { time: point.time, value, color } : { time: point.time, value };
}

function serializePlot(key: string, plot: PineTsPlot): PlotSeries {
  const options = { ...(plot.options ?? {}) };
  const style = typeof options.style === "string" ? options.style : "line";
  delete options.style;
  return {
    key,
    title: typeof plot.title === "string" ? plot.title : key,
    style,
    options,
    points: (plot.data ?? []).map(serializePoint),
  };
}

/** Drawing objects live in the value of the last data point of their hidden plot. */
function finalDrawings(plot: PineTsPlot | undefined): Record<string, unknown>[] {
  const last = plot?.data?.at(-1)?.value;
  if (!Array.isArray(last)) return [];
  return last.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && (item as Record<string, unknown>)._deleted !== true,
  );
}

export function serializeInputs(indicator: Indicator): InputMeta[] {
  return indicator.getInputsMeta().map((meta) => {
    const m = meta as unknown as Record<string, unknown>;
    const out: InputMeta = {
      id: String(m.id ?? ""),
      varId: String(m.varId ?? ""),
      title: String(m.title ?? m.name ?? ""),
      type: String(m.type ?? "unknown"),
      defval: m.defval,
    };
    if (typeof m.minval === "number") out.minval = m.minval;
    if (typeof m.maxval === "number") out.maxval = m.maxval;
    if (typeof m.step === "number") out.step = m.step;
    if (Array.isArray(m.options)) out.options = m.options;
    return out;
  });
}

export function serializeContext(
  ctx: Context,
  indicator: Indicator,
  meta: { durationMs: number; upgradedFromVersion: number | null },
): RunResult {
  const plots = ctx.plots as Record<string, PineTsPlot>;
  const declaration = ctx.indicator as { title?: string; shorttitle?: string; overlay?: boolean };
  return {
    title: declaration.title ?? "",
    shortTitle: declaration.shorttitle ?? "",
    overlay: declaration.overlay === true,
    inputs: serializeInputs(indicator),
    plots: Object.entries(plots)
      .filter(([key]) => !HIDDEN_PLOT_KEYS.has(key))
      .map(([key, plot]) => serializePlot(key, plot)),
    labels: finalDrawings(plots[DRAWING_KEYS.labels]),
    lines: finalDrawings(plots[DRAWING_KEYS.lines]),
    boxes: finalDrawings(plots[DRAWING_KEYS.boxes]),
    tables: finalDrawings(plots[DRAWING_KEYS.tables]),
    warnings: ctx.warnings.map((warning) => warning.message),
    upgradedFromVersion: meta.upgradedFromVersion,
    durationMs: meta.durationMs,
  };
}

const LOCATION_PATTERN = /\bat (\d+):(\d+)\b/u;

/** `lineOffset` is the number of lines the runner added above the user's source. */
export function toRunError(
  error: unknown,
  lineOffset = 0,
): { message: string; line?: number; column?: number } {
  const message = error instanceof Error ? error.message : String(error);
  const location = LOCATION_PATTERN.exec(message);
  if (!location) return { message };
  return {
    message,
    line: Math.max(1, Number(location[1]) - lineOffset),
    column: Number(location[2]),
  };
}
