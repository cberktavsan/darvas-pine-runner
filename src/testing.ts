// SPDX-License-Identifier: AGPL-3.0-only
// Shared fixtures for the test files.
import type { RunnerCandles } from "./protocol";

export const HOUR_MS = 3_600_000;
export const START_MS = 1_704_067_200_000;

export function syntheticCandles(count: number, stepMs = HOUR_MS): RunnerCandles {
  const candles: RunnerCandles = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const next = price + Math.sin(i / 4) + ((i * 7919) % 13) / 20 - 0.3;
    candles.time.push(START_MS + i * stepMs);
    candles.open.push(price);
    candles.high.push(Math.max(price, next) + 0.5);
    candles.low.push(Math.min(price, next) - 0.5);
    candles.close.push(next);
    candles.volume.push(1_000 + i);
    price = next;
  }
  return candles;
}
