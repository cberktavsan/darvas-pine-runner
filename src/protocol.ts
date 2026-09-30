// SPDX-License-Identifier: AGPL-3.0-only
// Message contract between a host page and the runner iframe.
// Every message carries a `type` prefixed with `pine-runner:`.

export const PROTOCOL_VERSION = 1;

export type ScalarInput = string | number | boolean;

/** Column-oriented OHLCV candles. `time` is the bar open time in milliseconds since epoch. */
export interface RunnerCandles {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export interface RunRequest {
  type: "pine-runner:run";
  id: string;
  source: string;
  candles: RunnerCandles;
  /** TradingView timeframe string: "1", "5", "60", "240", "D", "W", "M". */
  timeframe: string;
  symbol?: string;
  /** Input overrides keyed by the Pine variable name (`len = input.int(...)` is keyed "len"). */
  inputs?: Record<string, ScalarInput>;
  /** Wall-clock budget for the run. The runner terminates the worker when exceeded. */
  timeoutMs?: number;
}

export interface InputMeta {
  id: string;
  varId: string;
  title: string;
  type: string;
  defval: unknown;
  minval?: number;
  maxval?: number;
  step?: number;
  options?: unknown[];
}

export interface PlotPoint {
  time: number;
  /** Number for series plots, boolean for plotshape/plotchar, number[] for plotcandle/plotbar, null for na. */
  value: number | boolean | number[] | null;
  color?: string;
}

export interface PlotSeries {
  key: string;
  title: string;
  /** PineTS style token such as "line", "style_histogram", "hline", "fill", "shape", "char", "background", "barcolor", "candle". */
  style: string;
  options: Record<string, unknown>;
  points: PlotPoint[];
}

export interface RunResult {
  title: string;
  shortTitle: string;
  overlay: boolean;
  inputs: InputMeta[];
  plots: PlotSeries[];
  /** Final state of label.*, line.*, box.* and table.* objects, as PineTS stores them (x in bar index unless xloc is bar_time). */
  labels: Record<string, unknown>[];
  lines: Record<string, unknown>[];
  boxes: Record<string, unknown>[];
  tables: Record<string, unknown>[];
  warnings: string[];
  durationMs: number;
}

export interface RunError {
  message: string;
  line?: number;
  column?: number;
}

export interface ReadyMessage {
  type: "pine-runner:ready";
  protocol: typeof PROTOCOL_VERSION;
  pinets: string;
}

export interface RunReply {
  type: "pine-runner:result";
  id: string;
  ok: boolean;
  result?: RunResult;
  error?: RunError;
}

export type HostToRunner = RunRequest;
export type RunnerToHost = ReadyMessage | RunReply;

export function isRunRequest(value: unknown): value is RunRequest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    m.type === "pine-runner:run" &&
    typeof m.id === "string" &&
    typeof m.source === "string" &&
    typeof m.timeframe === "string" &&
    isCandles(m.candles)
  );
}

function isCandles(value: unknown): value is RunnerCandles {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  const columns = ["time", "open", "high", "low", "close", "volume"] as const;
  const lengths = columns.map((name) => (Array.isArray(c[name]) ? c[name].length : -1));
  return lengths[0]! > 0 && lengths.every((length) => length === lengths[0]);
}
