import { compileWasmResponse } from "./wasm-loader.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { mediaEnvelopeFromFrame, mediaFrameForEnvelope } from "./media-frame.js";
// Runtime bridge to Kasia's actual cipher WASM.
// Source is vendored from Kasia-staging/cipher and built with `npm run setup:cipher`.

let cipherModule = null;

export async function loadKasiaCipher() {
  if (cipherModule) return cipherModule;

  try {
    // Bundler-friendly relative import (mirrors engine/wasm-loader.js). The old absolute,
    // @vite-ignore'd "/cipher/cipher.js" only works on the dev server: a production `vite build`
    // never emitted it, so a statically-served build 404'd → SPA fallback served index.html →
    // "expected a JS module but got text/html". A dynamic relative import makes rolldown bundle
    // the cipher glue AND emit cipher_bg.wasm as a hashed asset.
    cipherModule = await import("../cipher/cipher.js");
    if (typeof cipherModule.default === "function") {
      // Fetch the wasm ourselves and instantiate from bytes, bypassing instantiateStreaming's
      // application/wasm MIME requirement (a reverse proxy / static host often serves it wrong).
      const wasmUrl = new URL("../cipher/cipher_bg.wasm", import.meta.url);
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`Could not fetch Kasia cipher WASM (HTTP ${response.status}) from ${wasmUrl.pathname}`);
      await cipherModule.default({ module_or_path: await compileWasmResponse(response) });
    }
    return cipherModule;
  } catch (error) {
    cipherModule = null;
    throw new Error(
      `Kasia cipher runtime failed to load. If this is a build, ensure npm run setup:cipher ran before it. (${error.message})`,
    );
  }
}


export async function deriveKasiaAliases(privateKeyHex, peerAddress) {
  const cipher = await loadKasiaCipher();
  if (typeof cipher.derive_my_alias !== "function" || typeof cipher.derive_their_alias !== "function") {
    throw new Error("Kasia cipher runtime is missing deterministic alias support. Re-run npm run setup:cipher.");
  }
  const myAlias = cipher.derive_my_alias(String(privateKeyHex), String(peerAddress));
  const theirAlias = cipher.derive_their_alias(String(privateKeyHex), String(peerAddress));
  return { myAlias, theirAlias };
}

export function isKasiaCipherLoaded() {
  return Boolean(cipherModule);
}

export async function encryptKasiaMessage(receiverAddress, clearText) {
  const cipher = await loadKasiaCipher();
  const encrypted = cipher.encrypt_message(String(receiverAddress), String(clearText));
  const encryptedHex = encrypted.to_hex();
  return {
    encryptedHex,
    encryptedBytes: hexToBytes(encryptedHex),
  };
}

/** A 1:1 message (kchat:1:comm / dm) sealed to `receiverAddress`, as iOS
 *  KasiaTransactionBuilder.encryptContextualMessage: a photo or voice note (media-file JSON with
 *  an image/* or audio/* base64 data URL) is sealed as the binary media frame
 *  (engine/media-frame.js), everything else as UTF-8 text exactly as encryptKasiaMessage. */
export async function encryptKasiaContextualMessage(receiverAddress, clearText) {
  const cipher = await loadKasiaCipher();
  return encryptKasiaContextualMessageWith(cipher, receiverAddress, clearText);
}

export function encryptKasiaContextualMessageWith(cipher, receiverAddress, clearText) {
  const frame = mediaFrameForEnvelope(String(clearText));
  if (!frame) {
    const encryptedHex = cipher.encrypt_message(String(receiverAddress), String(clearText)).to_hex();
    return { encryptedHex, encryptedBytes: hexToBytes(encryptedHex), mediaFrame: false };
  }
  // The WASM only seals a &str, so raw bytes go through the same scheme in JS. The receiver's key
  // comes from the WASM's own address reading (x-only payload, even parity, as encrypt_message).
  const receiverPublicKeyHex = cipher.debug_address_to_pubkey(String(receiverAddress));
  const encryptedBytes = sealKasiaBytes(hexToBytes(receiverPublicKeyHex), frame);
  return { encryptedHex: bytesToHex(encryptedBytes), encryptedBytes, mediaFrame: true };
}

/** The plaintext of a Kasia-sealed message. Text decrypts in the WASM as always; only when its
 *  plaintext is not UTF-8 is it opened again here as bytes, and a binary media frame comes back
 *  as the media-file JSON its text form carried (iOS KasiaCipher.decrypt). Anything else that is
 *  not UTF-8 - a malformed frame included - fails exactly as before, as on iOS. */
export async function decryptKasiaMessage(encryptedHex, privateKeyHex) {
  const cipher = await loadKasiaCipher();
  return decryptKasiaMessageWith(cipher, encryptedHex, privateKeyHex);
}

export function decryptKasiaMessageWith(cipher, encryptedHex, privateKeyHex) {
  const encrypted = new cipher.EncryptedMessage(String(encryptedHex));
  const privateKey = new cipher.PrivateKey(String(privateKeyHex));
  try {
    return cipher.decrypt_message(encrypted, privateKey);
  } catch (error) {
    if (!/UTF-8/i.test(String(error?.message || error))) throw error;
    let media = null;
    try {
      media = mediaEnvelopeFromFrame(openKasiaBytes(hexToBytes(encryptedHex), hexToBytes(privateKeyHex)));
    } catch { media = null; }
    if (media == null) throw error;
    return media;
  }
}

// The vendored cipher's scheme (vendor/kasia-cipher/src/lib.rs encrypt_message / decrypt_message)
// over bytes: ECDH on secp256k1 with an ephemeral key, HKDF-SHA256 (no salt, empty info) of the
// shared x-coordinate to a 32-byte key, ChaCha20-Poly1305 with a random 12-byte nonce.
// Wire: nonce(12) || ephemeral SEC1-compressed public key(33) || ciphertext || tag(16).
const NONCE_BYTES = 12;
const EPHEMERAL_KEY_BYTES = 33;
const TAG_BYTES = 16;

function kasiaKey(sharedPoint) {
  return hkdf(sha256, sharedPoint.subarray(1, 33), undefined, new Uint8Array(0), 32);
}

/** Seals `plaintext` bytes to a SEC1 public key (33 or 65 bytes). */
export function sealKasiaBytes(receiverPublicKey, plaintext) {
  const ephemeralSecret = secp256k1.utils.randomSecretKey();
  const ephemeralPublic = secp256k1.getPublicKey(ephemeralSecret, true);
  const key = kasiaKey(secp256k1.getSharedSecret(ephemeralSecret, receiverPublicKey, true));
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = chacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(NONCE_BYTES + EPHEMERAL_KEY_BYTES + ciphertext.length);
  out.set(nonce, 0);
  out.set(ephemeralPublic, NONCE_BYTES);
  out.set(ciphertext, NONCE_BYTES + EPHEMERAL_KEY_BYTES);
  return out;
}

/** Opens a sealed message to its raw plaintext bytes; throws when it is not ours or corrupted.
 *  Like EncryptedMessage.from_bytes, only a SEC1-compressed (02/03) ephemeral key is readable. */
export function openKasiaBytes(sealed, privateKey) {
  if (!sealed || sealed.length < NONCE_BYTES + EPHEMERAL_KEY_BYTES + TAG_BYTES) throw new Error("Encrypted message is too short.");
  const marker = sealed[NONCE_BYTES];
  if (marker !== 0x02 && marker !== 0x03) throw new Error("Invalid ephemeral public key.");
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const ephemeralPublic = sealed.subarray(NONCE_BYTES, NONCE_BYTES + EPHEMERAL_KEY_BYTES);
  const key = kasiaKey(secp256k1.getSharedSecret(privateKey, ephemeralPublic, true));
  return chacha20poly1305(key, nonce).decrypt(sealed.subarray(NONCE_BYTES + EPHEMERAL_KEY_BYTES));
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex) {
  const clean = String(hex || "").replace(/^0x/i, "");
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
    throw new Error("Invalid encrypted message hex.");
  }
  return Uint8Array.from(clean.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}
