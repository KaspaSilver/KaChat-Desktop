// A URL that is going into CSS `url("...")` (DSK-016). Profile banners/avatars come from KNS and
// .kachat profiles - data anyone can write - so only image-safe schemes pass, and the characters
// that could end the string or the url() token are percent-encoded.
//
// Remote: http(s) only. `allowLocal` also lets through what the app itself makes for local
// pictures: blob: object URLs (relayed .kachat images, Nextcloud thumbnails) and data:image/
// URLs (a picture picked in the profile editor). For those `;` is left alone - it separates
// `data:image/png;base64,` and encoding it would break the picture.

const REMOTE_RE = /^https?:\/\//i;
const BLOB_RE = /^blob:/i;
const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+[;,]/i;
// Every matched character is ASCII, so this is its exact %XX form. (encodeURIComponent would
// leave ' ( ) alone, and ' ends the url('...') string kaposts writes into a style attribute.)
const percentEncode = (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;

/** The URL made safe for CSS url("..."), or "" when it is not an image URL the app should load. */
export function safeCssUrl(raw, { allowLocal = false } = {}) {
  const value = String(raw || "").trim();
  if (REMOTE_RE.test(value)) return value.replace(/["'()\\\s;<>]/g, percentEncode);
  if (allowLocal && (BLOB_RE.test(value) || DATA_IMAGE_RE.test(value))) {
    return value.replace(/["'()\\\s<>]/g, percentEncode);
  }
  return "";
}

/** A whole `background-image` value (`url("...")`), or "" for no picture. */
export function cssUrlValue(raw, options) {
  const safe = safeCssUrl(raw, options);
  return safe ? `url("${safe}")` : "";
}
