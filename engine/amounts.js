// KAS amounts as exact sompi (iOS KaspaUnit.sompi(fromUserText:), IOS-010). Every amount and fee
// field a person types goes through sompiFromUserText: a comma or a dot as the decimal point
// (comma-decimal keyboards type "1,5"), at most 8 decimals, Arabic-Indic and Persian digits, no
// grouping, signs or exponents, integer (BigInt) math only, and null above the supply - so no
// input can be misread by float rounding or reach the WASM SDK as a value it panics on.
// No imports: the UI, the engine and the node tests all load this file as is.

export const SOMPI_PER_KAS = 100_000_000n;
/** Most sompi any typed amount can mean: a little above Kaspa's 28.7 billion KAS supply. */
export const MAX_TYPED_SOMPI = 29_000_000_000n * SOMPI_PER_KAS;
/** The largest amount a transaction field (u64) can hold. */
export const MAX_U64 = (1n << 64n) - 1n;

// Arabic-Indic and Persian digits (what those keyboards type) as ASCII digits, and the comma and
// the Arabic decimal separator as ".".
function asciiAmountChar(ch) {
  if (ch === "," || ch === "٫") return ".";
  const code = ch.codePointAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String.fromCharCode(code - 0x0660 + 0x30);
  if (code >= 0x06F0 && code <= 0x06F9) return String.fromCharCode(code - 0x06F0 + 0x30);
  return ch;
}

/**
 * A KAS amount the person typed, in sompi (BigInt): "1.5", "1,5", ".5", "5.", at most 8 decimals.
 * Null for anything else (empty, a second separator, grouping, a sign, an exponent, a 9th
 * decimal) and above MAX_TYPED_SOMPI. 0 is a valid result; callers that need a positive amount
 * check it.
 */
export function sompiFromUserText(text) {
  if (typeof text !== "string" && typeof text !== "number" && typeof text !== "bigint") return null;
  const t = Array.from(String(text).trim(), asciiAmountChar).join("");
  const dot = t.indexOf(".");
  const wholePart = dot === -1 ? t : t.slice(0, dot);
  const fracPart = dot === -1 ? "" : t.slice(dot + 1);
  if (!wholePart && !fracPart) return null;
  if (!/^[0-9]*$/.test(wholePart) || !/^[0-9]*$/.test(fracPart) || fracPart.length > 8) return null;
  const wholeDigits = wholePart.replace(/^0+/, "");
  // 29e9 KAS has 11 digits; anything longer is over the cap anyway.
  if (wholeDigits.length > 11) return null;
  const total = BigInt(wholeDigits || "0") * SOMPI_PER_KAS + BigInt((fracPart + "00000000").slice(0, 8));
  return total <= MAX_TYPED_SOMPI ? total : null;
}

/**
 * Cleans an amount field as it's typed: digits and one decimal point ("," and the Arabic decimal
 * separator become "."), Arabic-Indic / Persian digits as ASCII, at most `maxDecimals` decimals.
 */
export function sanitizeAmountInput(value, maxDecimals = 8) {
  let result = "";
  let dotSeen = false;
  let decimals = 0;
  for (const raw of String(value ?? "")) {
    const ch = asciiAmountChar(raw);
    if (ch === ".") {
      if (dotSeen) continue;
      dotSeen = true;
      result += ch;
    } else if (ch >= "0" && ch <= "9") {
      if (dotSeen) {
        if (decimals >= maxDecimals) continue;
        decimals += 1;
      }
      result += ch;
    }
  }
  return result;
}

/** Where this device writes the decimal point as "," (de, fr, es, it, pt, ru, tr, id, vi...), a
 *  comma is ALWAYS the decimal point - "0,001" pasted from a chat is 0.001, never 1 (iOS 73af28a,
 *  IOS-078) - and thousands show as a thin space ("2 500"), which no reader takes for a decimal.
 *  Elsewhere thousands show as "," ("12,345.5"). */
export function usesCommaDecimal(locale = undefined) {
  try {
    const part = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal");
    return part?.value === ",";
  } catch { return false; }
}
const THIN_SPACE = "\u202F";

/** "12345.5" -> "12,345.5" (or "12 345.5" where "," is the decimal point): a separator every
 *  three digits of the whole part, the rest as typed (iOS KaspaAmountEntry.grouped). Anything
 *  that isn't a plain amount comes back unchanged. */
export function groupedAmountText(plain, { commaDecimal = false } = {}) {
  const text = String(plain ?? "");
  const dot = text.indexOf(".");
  const whole = dot < 0 ? text : text.slice(0, dot);
  if (whole.length <= 3 || !/^[0-9]+$/.test(whole)) return text;
  const separator = commaDecimal ? THIN_SPACE : ",";
  let out = "";
  for (let i = 0; i < whole.length; i += 1) {
    if (i > 0 && (whole.length - i) % 3 === 0) out += separator;
    out += whole[i];
  }
  return dot < 0 ? out : out + text.slice(dot);
}

/** The edited field back to a plain number, "." the decimal point (iOS KaspaAmountEntry.ungrouped).
 *  - Comma-decimal device: the thin spaces shown are ours and go; a "," is the decimal point, and
 *    a pasted "1.234,5" (dots as grouping, a comma decimal) is 1234.5 - but a "," typed into an
 *    amount that already shows its point ("0.5" -> "0.5,") is a second separator and is ignored.
 *  - Otherwise: the commas shown are ours and go; a comma TYPED as the decimal point stays one:
 *    typed at the end, a single comma not three digits from the end in a number that had no
 *    grouping ("0,5" is 0.5, never 5), or after a lone leading zero ("0,001" is 0.001 - no
 *    grouped number starts "0,"). */
export function ungroupedAmountText(edited, previous, { commaDecimal = false } = {}) {
  let text = String(edited ?? "");
  const before = String(previous ?? "");
  if (commaDecimal) {
    text = text.replace(/[\u202F\u00A0 ]/g, "");
    const shownBefore = before.replace(/[\u202F\u00A0 ]/g, "");
    if (text.includes(",")) {
      // one "," typed into an amount that already shows its decimal point is a second separator:
      // ignored, so "0.5" stays 0.5 and never becomes 5 (IOS-082)
      if (shownBefore.includes(".") && text.length === shownBefore.length + 1) return text.replaceAll(",", "");
      // pasted or typed fresh: a comma is the decimal point; dots beside it can only be grouping
      text = text.replaceAll(".", "");
      const first = text.indexOf(",");
      text = `${text.slice(0, first)}.${text.slice(first + 1).replaceAll(",", "")}`;
    }
    return text;
  }
  if (text === before + ",") return before.replaceAll(",", "") + ".";
  const comma = text.indexOf(",");
  if (!before.includes(",") && !text.includes(".") && comma >= 0 && comma === text.lastIndexOf(",")) {
    const head = text.slice(0, comma);
    if (head === "0" || head === "" || text.length - comma - 1 !== 3) return text.replace(",", ".");
  }
  return text.replaceAll(",", "");
}

/** Sompi as plain KAS text: up to 8 decimals, trailing zeros dropped ("1.5", "0", "-2"). Exact. */
export function kasTextFromSompi(sompi) {
  let value;
  try { value = BigInt(sompi ?? 0); } catch { return "0"; }
  const negative = value < 0n;
  if (negative) value = -value;
  const whole = value / SOMPI_PER_KAS;
  const fraction = (value % SOMPI_PER_KAS).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * An amount handed to the engine in KAS, in sompi (BigInt), or null when it isn't one. Strings go
 * through sompiFromUserText; a plain decimal string with more than 8 decimals (float arithmetic
 * such as "0.30000000000000004") is cut to 8, as the SDK's own kaspaToSompi does; a JS number is
 * read through its 8-decimal fixed form. Never throws, never returns more than MAX_TYPED_SOMPI.
 */
export function kasToSompi(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 3e10) return null;
    return sompiFromUserText(value.toFixed(10).replace(/(\.\d{8})\d+$/, "$1"));
  }
  const text = String(value).trim();
  const exact = sompiFromUserText(text);
  if (exact != null) return exact;
  const long = /^([0-9]*)\.([0-9]{9,})$/.exec(text);
  return long ? sompiFromUserText(`${long[1]}.${long[2].slice(0, 8)}`) : null;
}

/** A little above Kaspa's 28.7 billion KAS supply, in sompi (iOS UTXO.maxSompi): more than any coin,
 *  or all of an answer's coins together, can hold. */
export const MAX_SUPPLY_SOMPI = 29_000_000_000n * 100_000_000n;

/** A node's answer the app refuses as impossible: the node is at fault, not the connection, so
 *  withRpc forgets that node and asks another one (DSK-046). */
export class BadNodeAnswerError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadNodeAnswerError";
    this.badNode = true;
  }
}

/** A node's getUtxosByAddresses answer as the app may use it (iOS checkedFromNetwork, IOS-020): a
 *  coin or a total above the Kaspa supply is a broken or hostile peer's, refused where it's read so
 *  no balance, contact sum or Max further on works with it. Non-integer amounts are left for
 *  sanitizeUtxoEntries to drop. Returns the response; throws a BadNodeAnswerError otherwise, which
 *  withRpc answers by dropping that node and retrying on another (iOS: another node's hedged answer
 *  wins). */
export function checkedUtxoAnswer(response) {
  let total = 0n;
  for (const entry of response?.entries || []) {
    const raw = entry?.amount ?? entry?.entry?.amount ?? entry?.utxoEntry?.amount ?? 0;
    let value;
    try { value = BigInt(raw); } catch { continue; }
    if (value > MAX_SUPPLY_SOMPI) throw new BadNodeAnswerError("Invalid UTXO data: amount above the Kaspa supply");
    if (value > 0n) total += value;
  }
  if (total > MAX_SUPPLY_SOMPI) throw new BadNodeAnswerError("Invalid UTXO data: amount above the Kaspa supply");
  return response;
}

/** A node-supplied UTXO amount as BigInt sompi, or null when it is not a whole number in (0, u64]. */
export function utxoAmountSompi(entry) {
  const raw = entry?.amount ?? entry?.value ?? null;
  if (raw == null) return null;
  let value;
  try {
    if (typeof raw === "number" && !Number.isSafeInteger(raw)) return null;
    value = BigInt(raw);
  } catch { return null; }
  return value > 0n && value <= MAX_U64 ? value : null;
}

/**
 * A KAS amount in sompi as currency text, rounded DOWN to `decimals` places (audit DSK-042): a Max
 * shown in a currency must never convert back to more than the balance. "" without a price.
 */
export function fiatTextFloorFromSompi(sompi, price, decimals = 2) {
  const p = Number(price);
  let value;
  try { value = Number(BigInt(sompi ?? 0)) / 1e8; } catch { return ""; }
  if (!(p > 0) || !Number.isFinite(value) || value < 0) return "";
  const scale = 10 ** decimals;
  return (Math.floor(value * p * scale) / scale).toFixed(decimals);
}
