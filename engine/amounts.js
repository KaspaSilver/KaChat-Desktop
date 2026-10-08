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
