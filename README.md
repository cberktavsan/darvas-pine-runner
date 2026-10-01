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
a sandboxed iframe on the runner's own origin, with a Content-Security-Policy of
`connect-src 'none'`. The embedding page's cookies and storage are on another origin, so a script
can waste the visitor's own CPU and nothing else. The host page terminates the worker when a run
exceeds its time budget.

Use `sandbox="allow-scripts allow-same-origin"`, not `allow-scripts` alone: an opaque origin makes
the CSP `'self'` source match nothing, which blocks the runner's own scripts.

## Embedding

```html
<iframe src="https://pine.example.com/" sandbox="allow-scripts allow-same-origin" hidden></iframe>
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
  "https://pine.example.com",
);
```

The runner answers to `event.source` with the sender's origin.

## Protocol

Types live in `src/protocol.ts`.

### `pine-runner:ready` (runner to host)

Sent once after the page loads. Carries `protocol` (currently `2`) and the `pinets` version.

### `pine-runner:run` (host to runner)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Echoed in the reply. |
| `source` | string | Pine Script v1 to v6, or PineTS JavaScript syntax. Scripts older than v5 are rewritten to v5 first (see below). |
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
- `upgradedFromVersion`: the script's original `//@version` when the runner rewrote it, else `null`.
- `durationMs`: wall-clock time of the run.

### `pine-runner:data-request` (runner to host) and `pine-runner:data-response` (host to runner)

The runner has no network access. When a script reads another symbol or timeframe with
`request.security()`, the runner asks the embedding page for those candles:

```json
{ "type": "pine-runner:data-request", "runId": "run-1", "requestId": "data-1",
  "symbol": "BTCUSDT", "timeframe": "D", "from": 1701475200000, "to": 1704067199999 }
```

`from`, `to` and `limit` are present when the script's range is known. The embedder answers with
the same ids:

```json
{ "type": "pine-runner:data-response", "runId": "run-1", "requestId": "data-1",
  "ok": true, "candles": { "time": [], "open": [], "high": [], "low": [], "close": [], "volume": [] } }
```

or `{ ..., "ok": false, "error": "no data" }`, which fails the run with that message. The embedder
has 15 seconds per request; the wait does not count against the script's time budget. A run may
make at most 12 data requests. The chart's own symbol and timeframe are served from the run
request and never asked for.

The embedder decides what it serves. Treat the request as untrusted input: it comes from a user
script, so validate the symbol and timeframe and serve only data the user may read.

## Legacy scripts

PineTS accepts v5 and v6 only. `src/legacy.ts` rewrites v1 to v4 source into v5 before it runs:
`study()` to `indicator()`, the `ta.`, `math.`, `str.` and `request.` namespaces, typed `input()`
calls, the removed `transp` argument, `iff()`, and the bare colour and style names of v3. Names the
script declares itself are left alone. The rewrite keeps line numbers, so error locations match the
original source. It is a syntactic translation: results can differ from TradingView where v4 and v5
semantics differ, and `upgradedFromVersion` lets the embedder say so.

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
