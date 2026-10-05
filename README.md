# darvas-pine-runner

A standalone runner for [Pine Script](https://www.tradingview.com/pine-script-docs/) indicators. It wraps
[PineTS](https://github.com/LuxAlgo/PineTS) in a Web Worker behind a static page. An embedding
application opens the page in a sandboxed iframe, sends a script plus candles with `postMessage`,
and receives plot series and drawings as JSON.

The runner is a separate program with its own origin. It stores nothing, calls no network, and
knows nothing about the application that embeds it. Any page can use it through the protocol below.

License: AGPL-3.0-only (see `LICENSE`). PineTS is AGPL-3.0 as well.

The same runner also works as an HTTP server that runs each script in a Deno process with no
permissions. See [Server mode](#server-mode).

## Why an iframe

PineTS transpiles Pine to JavaScript and evaluates it with `new Function`. A script therefore runs
with the full privileges of its JavaScript context. Running user scripts in an ordinary server
process would let a script read `process.env` or call `fetch`. In browser mode the runner keeps
scripts in the visitor's browser, inside a sandboxed iframe on the runner's own origin. The embedding page's cookies and storage are on
another origin, so a script cannot read them.

The page's Content-Security-Policy is `connect-src 'none'`, and the worker that runs the script is
started from a blob URL, so it inherits that policy: `fetch`, `XMLHttpRequest` and `WebSocket` fail
inside a script. The policy has to allow `'unsafe-eval'` because PineTS needs it. A script can waste
the visitor's own CPU and nothing else, and the host page terminates the worker when a run exceeds
its time budget. `bun run dev` serves the worker as a normal module without this policy; test the
network block against `bun run build` and `bun run preview`.

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
- `inputs`: one entry per `input.*` call with `id`, `varId`, `title`, `type`, `defval`, bounds,
  `options`, and `value`, the value this run used. An override in the request's `inputs` that names
  no input or that the input rejects is skipped and listed in `warnings`.
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

`dist/` is static and uses relative asset URLs, so it can live on any static host or path. Serve it
from an origin other than the embedding application's. The policy lives in a meta tag in
`index.html`; `deploy/nginx.conf` shows how to repeat it as a header on a host you control.

## Server mode

`bun run build:server` writes two bundles to `dist-server/`:

- `main.js`, an HTTP server for [Deno](https://deno.com). `scripts/serve.sh` starts it with only
  the permissions it needs: listening on its address, reading its `PINE_RUNNER_*` settings and
  starting Deno again.
- `child.js`, which runs one script. The server starts it for every request with an empty
  environment and no permission except reading one PineTS switch by name. It has no network, no
  file system and no subprocesses, reads the request from stdin and writes the answer to stdout.
  The server kills it after 10 seconds.

Settings: `PINE_RUNNER_TOKEN` (required, 32 characters or more), `PINE_RUNNER_HOST` (default
`127.0.0.1`), `PINE_RUNNER_PORT` (default `8787`), `PINE_RUNNER_CONCURRENCY` (default `2`).

```
POST /run            Authorization: Bearer <token>
{ "source": "...", "candles": { "time": [...], ... }, "timeframe": "60", "symbol": "BTCUSDT",
  "inputs": { "len": 21 }, "series": [] }
```

The answer is `{ "ok": true, "result": RunResult }`, `{ "ok": false, "error": RunError }`, or
`{ "ok": false, "needs": [{ "symbol", "timeframe", "limit"?, "from"?, "to"? }] }`. `needs` lists
the series a script read with `request.security` that the request did not carry. The runner has no
network, so the caller fetches those candles and posts the run again with them in `series`.
`GET /health` needs no token.

Deno's permissions are the first wall, not the only one. Run the server on a host that holds no
secrets, as an unprivileged user, with the listener on loopback, outbound traffic blocked and
memory and CPU capped for the whole service. `deploy/pine-runner.service` is a systemd unit that
does this.
