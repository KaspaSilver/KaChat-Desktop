// Name normalization for the outside name services - a port of iOS NameNormalization, which
// ported each service's own SDK. Adjudication-critical: a normalizer that disagrees with the
// service's on one byte can resolve a typed name to the wrong owner. Checked against both SDKs'
// published vectors (tools/check-name-vectors.mjs); re-run it whenever an SDK's vectors change.
//
// No imports on purpose, so the vector check runs in plain Node.

// Unicode White_Space, the set Swift's `properties.isWhitespace` (and dotk's trim) uses.
const WHITE_SPACE = "\t\n\u000B\f\r \u0085                 　";

/** `.k` (dotk, @dotk/sdk names.ts): trim White_Space, lowercase A-Z only, drop one ".k". */
export function dotkNormalize(input) {
  const chars = [...String(input ?? "")];
  while (chars.length && WHITE_SPACE.includes(chars[0])) chars.shift();
  while (chars.length && WHITE_SPACE.includes(chars[chars.length - 1])) chars.pop();
  const lowered = chars.map((c) => (c >= "A" && c <= "Z" ? c.toLowerCase() : c)).join("");
  return lowered.endsWith(".k") ? lowered.slice(0, -2) : lowered;
}

/** Why a normalized `.k` name is invalid, in dotk's words; null when it is valid. */
export function dotkInvalidReason(name) {
  if (![...name].every((c) => /^[a-z0-9-]$/.test(c))) return "allowed characters: a-z, 0-9 and hyphen";
  const bytes = new TextEncoder().encode(name).length;
  if (bytes === 0 || bytes > 32) return "name must be 1..=32 bytes on-chain";
  if (name.startsWith("-") || name.endsWith("-")) return "name cannot start or end with a hyphen";
  return null;
}

/** The canonical `.k` name for typed input, or null when it is not one. */
export function dotkCanonical(input) {
  const name = dotkNormalize(input);
  return dotkInvalidReason(name) == null ? name : null;
}

/**
 * `.kaspa` (Kaspa Names, @kronsdk/kaspa-names normalize.ts): NFKC, printable ASCII only,
 * lowercase, drop one ".kaspa"; valid when 1..32 of a-z, 0-9 and hyphen, no hyphen at either end.
 */
export function kaspaNamesCanonical(input) {
  const nfkc = String(input ?? "").normalize("NFKC");
  for (let i = 0; i < nfkc.length; i += 1) {
    const unit = nfkc.charCodeAt(i);
    if (unit > 0x7e || unit < 0x21) return null;
  }
  let s = nfkc.toLowerCase();
  if (s.endsWith(".kaspa")) s = s.slice(0, -6);
  if (s.length < 1 || s.length > 32) return null;
  if (!/^[a-z0-9-]+$/.test(s)) return null;
  if (s.startsWith("-") || s.endsWith("-")) return null;
  return s;
}
