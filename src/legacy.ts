// SPDX-License-Identifier: AGPL-3.0-only
// Rewrites Pine Script v1-v4 source into v5 syntax so PineTS can run it.
// PineTS only accepts v5 and v6; this covers the renames TradingView's own converter performs:
// namespaces (ta., math., str., request.), study() -> indicator(), typed input() calls,
// the removed `transp` argument, iff(), and the bare colour and style names of v3.

export interface LegacyUpgrade {
  source: string;
  /** The script's original version when it was rewritten, otherwise null. */
  fromVersion: number | null;
  /** Lines added above the original source; error locations shift by this much. */
  lineOffset: number;
}

const VERSION_LINE = /^([ \t]*\/\/[ \t]*@version[ \t]*=[ \t]*)(\d+)/m;
const MASK_OPEN = "";
const MASK_CLOSE = "";

const TA_FUNCTIONS = new Set([
  "alma", "atr", "barssince", "bb", "bbw", "cci", "change", "cmo", "cog", "correlation", "cross",
  "crossover", "crossunder", "cum", "dev", "dmi", "ema", "falling", "highest", "highestbars", "hma",
  "kc", "kcw", "linreg", "lowest", "lowestbars", "macd", "median", "mfi", "mode", "mom",
  "percentile_linear_interpolation", "percentile_nearest_rank", "percentrank", "pivothigh",
  "pivotlow", "range", "rising", "rma", "roc", "rsi", "sar", "sma", "stdev", "stoch", "supertrend",
  "swma", "tr", "tsi", "valuewhen", "variance", "vwap", "vwma", "wma", "wpr",
]);
const MATH_FUNCTIONS = new Set([
  "abs", "acos", "asin", "atan", "avg", "ceil", "cos", "exp", "floor", "log", "log10", "max", "min",
  "pow", "random", "round", "round_to_mintick", "sign", "sin", "sqrt", "sum", "tan", "todegrees",
  "toradians",
]);
const OTHER_FUNCTIONS: Record<string, string> = {
  study: "indicator",
  security: "request.security",
  financial: "request.financial",
  dividends: "request.dividends",
  earnings: "request.earnings",
  splits: "request.splits",
  quandl: "request.quandl",
  tostring: "str.tostring",
  tonumber: "str.tonumber",
  heikinashi: "ticker.heikinashi",
  renko: "ticker.renko",
  kagi: "ticker.kagi",
  linebreak: "ticker.linebreak",
  pointfigure: "ticker.pointfigure",
};
const TA_VARIABLES = ["accdist", "iii", "nvi", "obv", "pvi", "pvt", "tr", "vwap", "wad", "wvad"];
const V3_VARIABLES: Record<string, string> = {
  n: "bar_index",
  tickerid: "syminfo.tickerid",
  ticker: "syminfo.ticker",
  period: "timeframe.period",
  interval: "timeframe.multiplier",
  isintraday: "timeframe.isintraday",
  isdaily: "timeframe.isdaily",
  isweekly: "timeframe.isweekly",
  ismonthly: "timeframe.ismonthly",
  isdwm: "timeframe.isdwm",
};
const V3_COLORS = [
  "aqua", "black", "blue", "fuchsia", "gray", "green", "lime", "maroon", "navy", "olive", "orange",
  "purple", "red", "silver", "teal", "white", "yellow",
];
const PLOT_STYLES = [
  "line", "stepline", "histogram", "cross", "area", "columns", "circles", "linebr", "areabr",
];
const INPUT_KINDS: Record<string, string> = {
  integer: "int",
  float: "float",
  bool: "bool",
  string: "string",
  source: "source",
  symbol: "symbol",
  resolution: "timeframe",
  session: "session",
  color: "color",
  time: "time",
};
/** Position of the colour argument when it is passed positionally. */
const COLOR_POSITION: Record<string, number> = {
  plot: 2, plotshape: 4, plotchar: 4, plotcandle: 5, plotbar: 5, fill: 2, bgcolor: 0, barcolor: 0,
};
const TRANSP_POSITION: Record<string, number> = { bgcolor: 1, fill: 3 };
const LABEL_STYLES = /\blabel\.style_label(up|down|left|right|center)\b/g;
const LABEL_CORNERS = /\blabel\.style_label(upper|lower)(left|right)\b/g;

interface Masked {
  text: string;
  parts: string[];
}

/** Replaces string literals and comments with placeholders so rewrites only touch code. */
function mask(source: string): Masked {
  const parts: string[] = [];
  let text = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    let end = -1;
    if (char === "/" && source[i + 1] === "/") {
      end = source.indexOf("\n", i);
      if (end === -1) end = source.length;
    } else if (char === '"' || char === "'") {
      end = i + 1;
      while (end < source.length && source[end] !== char && source[end] !== "\n") {
        end += source[end] === "\\" ? 2 : 1;
      }
      end = Math.min(end + 1, source.length);
    }
    if (end === -1) {
      text += char;
      i += 1;
      continue;
    }
    text += `${MASK_OPEN}${parts.length}${MASK_CLOSE}`;
    parts.push(source.slice(i, end));
    i = end;
  }
  return { text, parts };
}

function unmask(masked: Masked): string {
  return masked.text.replace(
    new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "g"),
    (_, index: string) => masked.parts[Number(index)] ?? "",
  );
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (text.slice(start).trim().length > 0 || args.length > 0) args.push(text.slice(start));
  return args;
}

const NAMED_ARG = /^(\s*)([A-Za-z_]\w*)(\s*=(?!=)\s*)([\s\S]*)$/;

interface Arg {
  name: string | null;
  value: string;
  /** Leading whitespace plus `name =`, kept so line breaks inside calls survive. */
  prefix: string;
}

function parseArg(raw: string): Arg {
  const named = NAMED_ARG.exec(raw);
  if (named) return { name: named[2]!, value: named[4]!, prefix: `${named[1]}${named[2]}${named[3]}` };
  const lead = /^\s*/.exec(raw)![0];
  return { name: null, value: raw.slice(lead.length), prefix: lead };
}

const printArg = (arg: Arg): string => `${arg.prefix}${arg.value}`;

function inputKind(value: string): string | null {
  return INPUT_KINDS[value.trim().replace(/^input\./, "")] ?? null;
}

const TYPED_ONLY_ARGS = new Set(["minval", "maxval", "step", "options"]);

/** v5's plain input() rejects minval, maxval, step and options, so the default decides the kind. */
function inferInputKind(args: Arg[], isString: (value: string) => boolean): string | null {
  if (!args.some((arg) => arg.name !== null && TYPED_ONLY_ARGS.has(arg.name))) return null;
  const defval = (args.find((arg) => arg.name === "defval") ?? args.find((arg) => arg.name === null))
    ?.value.trim();
  if (defval === undefined) return null;
  if (isString(defval)) return "string";
  if (defval === "true" || defval === "false") return "bool";
  if (/^-?\d+$/.test(defval)) return "int";
  if (/^-?(\d+\.\d*|\.\d+)(e-?\d+)?$/i.test(defval)) return "float";
  return null;
}

function rewriteInput(args: Arg[], isString: (value: string) => boolean): string | null {
  let index = args.findIndex((arg) => arg.name === "type");
  // input(defval, title, type) is the positional v3 form.
  if (index === -1 && args[2] && args[2].name === null && inputKind(args[2].value)) index = 2;
  const kind = index === -1 ? inferInputKind(args, isString) : inputKind(args[index]!.value);
  if (!kind) return null;
  const rest = args.filter((_, position) => position !== index);
  return `input.${kind}(${rest.map(printArg).join(",")})`;
}

function foldTransparency(name: string, args: Arg[]): string | null {
  let transp = args.findIndex((arg) => arg.name === "transp");
  const positional = TRANSP_POSITION[name];
  if (transp === -1 && positional !== undefined && args[positional]?.name === null) {
    transp = positional;
  }
  if (transp === -1) return null;
  let color = args.findIndex((arg) => arg.name === "color");
  const colorPosition = COLOR_POSITION[name];
  if (color === -1 && colorPosition !== undefined && args[colorPosition]?.name === null) {
    color = colorPosition;
  }
  const level = args[transp]!.value.trim();
  const next = args
    .map((arg, index) =>
      index === color ? { ...arg, value: `color.new(${arg.value.trim()}, ${level})` } : arg,
    )
    .filter((_, index) => index !== transp);
  return `${name}(${next.map(printArg).join(",")})`;
}

interface RewriteContext {
  userFunctions: Set<string>;
  isString: (value: string) => boolean;
}

function rewriteCall(name: string, rawArgs: string[], ctx: RewriteContext): string | null {
  if (ctx.userFunctions.has(name)) return null;
  const args = rawArgs.map(parseArg);
  if (name === "iff" && args.length === 3) {
    return `(${args[0]!.value.trim()} ? ${args[1]!.value.trim()} : ${args[2]!.value.trim()})`;
  }
  if (name === "color" && args.length === 2) return `color.new(${rawArgs.join(",")})`;
  if (name === "input") return rewriteInput(args, ctx.isString);
  if (name === "offset" && args.length === 2) {
    return `(${args[0]!.value.trim()})[${args[1]!.value.trim()}]`;
  }
  if (name in COLOR_POSITION || name === "plotarrow") return foldTransparency(name, args);
  if (name === "study") {
    const renamed = args.map((arg) =>
      arg.name === "resolution" ? { ...arg, prefix: arg.prefix.replace("resolution", "timeframe") } : arg,
    );
    return `indicator(${renamed.map(printArg).join(",")})`;
  }
  const other = OTHER_FUNCTIONS[name];
  if (other) return `${other}(${rawArgs.join(",")})`;
  if (TA_FUNCTIONS.has(name)) return `ta.${name}(${rawArgs.join(",")})`;
  if (MATH_FUNCTIONS.has(name)) return `math.${name}(${rawArgs.join(",")})`;
  return null;
}

const CALL = /(?<![\w.])([A-Za-z_]\w*)([ \t]*)\(/g;

/** Rewrites calls inside out, so nested legacy calls are converted before their parent. */
function rewriteCalls(text: string, ctx: RewriteContext): string {
  let result = "";
  let cursor = 0;
  CALL.lastIndex = 0;
  for (let match = CALL.exec(text); match; match = CALL.exec(text)) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(text, open);
    if (close === -1) break;
    const inner = rewriteCalls(text.slice(open + 1, close), ctx);
    const rewritten = rewriteCall(match[1]!, splitArgs(inner), ctx);
    result += text.slice(cursor, match.index);
    result += rewritten ?? `${match[1]}${match[2]}(${inner})`;
    cursor = close + 1;
    CALL.lastIndex = cursor;
  }
  return result + text.slice(cursor);
}

/** Names the script declares itself; a built-in with the same name must not be renamed. */
function declaredNames(text: string): { functions: Set<string>; variables: Set<string> } {
  const functions = new Set<string>();
  const variables = new Set<string>();
  for (const match of text.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]*\(([^()]*)\)[ \t]*=>/gm)) {
    functions.add(match[1]!);
    for (const param of match[2]!.split(",")) {
      const name = /([A-Za-z_]\w*)\s*(?:=.*)?$/.exec(param.trim())?.[1];
      if (name) variables.add(name);
    }
  }
  for (const match of text.matchAll(/^[ \t]*(?:var[ \t]+)?(?:[a-z]+[ \t]+)?([A-Za-z_]\w*)[ \t]*(?::=|=(?!=))/gm)) {
    variables.add(match[1]!);
  }
  for (const match of text.matchAll(/^[ \t]*\[([^\]]+)\][ \t]*=(?!=)/gm)) {
    for (const name of match[1]!.split(",")) variables.add(name.trim());
  }
  for (const match of text.matchAll(/\bfor[ \t]+([A-Za-z_]\w*)[ \t]*=/g)) variables.add(match[1]!);
  return { functions, variables };
}

function renameVariable(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`(?<![\\w.])${from}(?![\\w(]|[ \\t]*=(?!=))`, "g"), to);
}

function renameVariables(text: string, version: number, declared: Set<string>): string {
  let next = text;
  for (const name of TA_VARIABLES) {
    if (!declared.has(name)) next = renameVariable(next, name, `ta.${name}`);
  }
  if (version > 3) return next;
  for (const [name, replacement] of Object.entries(V3_VARIABLES)) {
    if (!declared.has(name)) next = renameVariable(next, name, replacement);
  }
  for (const name of V3_COLORS) {
    if (!declared.has(name)) next = renameVariable(next, name, `color.${name}`);
  }
  next = next.replace(
    new RegExp(`(\\bstyle[ \\t]*=[ \\t]*)(${PLOT_STYLES.join("|")})\\b`, "g"),
    "$1plot.style_$2",
  );
  return next.replace(/(\blinestyle[ \t]*=[ \t]*)(solid|dashed|dotted)\b/g, "$1hline.style_$2");
}

export function upgradeLegacyPine(source: string): LegacyUpgrade {
  const versionMatch = VERSION_LINE.exec(source);
  const version = versionMatch ? Number(versionMatch[2]) : /(?<![\w.])study\s*\(/.test(source) ? 1 : null;
  if (version === null || version >= 5) return { source, fromVersion: null, lineOffset: 0 };

  const masked = mask(versionMatch ? source.replace(VERSION_LINE, "$15") : `//@version=5\n${source}`);
  const declared = declaredNames(masked.text);
  const stringPart = new RegExp(`^${MASK_OPEN}(\\d+)${MASK_CLOSE}$`);
  const isString = (value: string): boolean => {
    const part = masked.parts[Number(stringPart.exec(value)?.[1] ?? -1)];
    return part !== undefined && !part.startsWith("//");
  };
  let text = rewriteCalls(masked.text, { userFunctions: declared.functions, isString });
  text = renameVariables(text, version, declared.variables);
  text = text
    .replace(LABEL_CORNERS, "label.style_label_$1_$2")
    .replace(LABEL_STYLES, "label.style_label_$1");
  return {
    source: unmask({ text, parts: masked.parts }),
    fromVersion: version,
    lineOffset: versionMatch ? 0 : 1,
  };
}
