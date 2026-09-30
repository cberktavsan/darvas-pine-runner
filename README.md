# darvas-pine-runner

A standalone runner for [Pine Script](https://www.tradingview.com/pine-script-docs/) indicators. It wraps
[PineTS](https://github.com/LuxAlgo/PineTS) in a Web Worker behind a static page. An embedding
application opens the page in a sandboxed iframe, sends a script plus candles with `postMessage`,
and receives plot series and drawings as JSON.

The runner is a separate program with its own origin. It stores nothing, calls no network, and
knows nothing about the application that embeds it. Any page can use it through the protocol below.

License: AGPL-3.0-only (see `LICENSE`). PineTS is AGPL-3.0 as well.

## Why an iframe

PineTS transpiles Pine to JavaScript and evaluates it with `new Function`. A script therefore runs
with the full privileges of its JavaScript context. Running user scripts on a server would let a
script read `process.env` or call `fetch`. The runner keeps scripts in the visitor's browser, inside
an iframe whose `sandbox="allow-scripts"` attribute gives it an opaque origin, with a
Content-Security-Policy of `connect-src 'none'`. A script can waste the visitor's own CPU and
nothing else. The host page terminates the worker when a run exceeds its time budget.

## Embedding

```html
<iframe src="https://pine.example.com/" sandbox="allow-scripts" hidden></iframe>
```

```js
const frame = document.querySelector("iframe");
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  if (event.data.type === "pine-runner:ready") console.log("pinets", event.data.pinets);
  if (event.data.type === "pine-runner:result") console.log(event.data);
});
frame.contentWindow.postMessage(
  {
    type: "pine-runner:run",
    id: "run-1",
    source: '//@version=6\nindicator("EMA")\nplot(ta.ema(close, 20))',
    timeframe: "60",
    symbol: "BTCUSDT",
    candles: { time: [...], open: [...], high: [...], low: [...], close: [...], volume: [...] },
    timeoutMs: 10000,
  },
  "*",
);
```

Because the iframe origin is opaque, the target origin of `postMessage` has to be `"*"`. The runner
answers to `event.source` with the sender's origin.

## Protocol

Types live in `src/protocol.ts`.

### `pine-runner:ready` (runner to host)

Sent once after the page loads. Carries `protocol` (currently `1`) and the `pinets` version.

### `pine-runner:run` (host to runner)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Echoed in the reply. |
| `source` | string | Native Pine Script v5 or v6, or PineTS JavaScript syntax. |
| `candles` | columnar OHLCV | `time` is the bar open time in milliseconds since epoch. All columns share one length. |
| `timeframe` | string | TradingView format: `1`, `5`, `15`, `60`, `240`, `D`, `W`, `M`. |
| `symbol` | string, optional | Exposed to the script as `syminfo.ticker`. |
| `inputs` | object, optional | Input overrides keyed by the Pine variable name. |
| `timeoutMs` | number, optional | Default 10000, maximum 60000. |

Runs execute one at a time in arrival order.

### `pine-runner:result` (runner to host)

`{ id, ok: true, result }` or `{ id, ok: false, error: { message, line?, column? } }`.

`result` contains:

- `title`, `shortTitle`, `overlay` from the `indicator()` declaration.
- `inputs`: one entry per `input.*` call with `varId`, `title`, `type`, `defval` and bounds.
- `plots`: every visual call in declaration order. `style` is the PineTS style token: `line`,
  `style_histogram`, `style_columns`, `style_area`, `style_stepline`, `style_circles`,
  `style_cross`, `hline`, `fill`, `shape`, `char`, `background`, `barcolor`, `candle`, `bar`.
  `options` holds the remaining call arguments (`color`, `linewidth`, `plot1`/`plot2` for fills,
  `shape`/`location`/`text` for shapes). `points` has one entry per bar with `value` as a number,
  a boolean for shapes and chars, a four-number array for candles, or `null` for `na`. A point's
  `color` is present when the script coloured that bar.
- `labels`, `lines`, `boxes`, `tables`: the final state of drawing objects, as PineTS stores them.
  `x` coordinates are bar indexes unless the object's `xloc` is `bt` (bar time).
- `warnings`: runtime warnings PineTS collected.
- `durationMs`: wall-clock time of the run.

## Development

```bash
bun install
bun run dev        # http://localhost:5174
bun test
bun run typecheck
bun run build      # dist/
bun run preview    # serves dist/ on 5174
```

## Deployment

`dist/` is static. Serve it from its own hostname and repeat the Content-Security-Policy from
`index.html` as an HTTP header so it also covers the worker script. `deploy/nginx.conf` is a
starting point.
