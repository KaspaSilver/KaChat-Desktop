// node tools/test-passphrase-nfkd.mjs - BIP39 passphrase normalization (audit EXT-010) against the
// real Kaspa WASM, plus an independent BIP39 + BIP32 reference (Node PBKDF2-HMAC-SHA512 and
// @noble/curves secp256k1), so the engine is not checked only against itself.
//
//   - "café" composed (U+00E9) and decomposed (e + U+0301) derive the same wallet (standard);
//   - that wallet matches PBKDF2(NFKD(phrase), "mnemonic" + NFKD(pass), 2048) + the same path;
//   - a "raw" account (saved before EXT-010) still derives exactly what the old code derived;
//   - ASCII passphrases derive the same either way;
//   - the saved-account rule (passphraseFormForRecord) and the flag surviving the key vault.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pbkdf2Sync, createHmac, webcrypto } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  importMnemonic, importMnemonicWithFamily, deriveIdentityAddressRange, deriveSpendingWallet,
  generateMnemonicWallet, oneKeyTweakPrivateKeyHex, seedPassphrase, passphraseIsNfkd,
  normalizePassphraseForm, passphraseFormForRecord, PASSPHRASE_FORMS,
} from "../engine/wallet.js";
import { NETWORK_ID } from "../engine/utils.js";
import { configureKeyVault, setAppPassword, lockKeyVault, unlockKeyVault, readAccountRecords, writeAccountRecords } from "../ui/key-vault.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CAFE_NFC = "café";
const CAFE_NFD = "café";
const GRUSSE_NFC = "Grüße 2026 Ａ"; // ü, ß and a full-width A (NFKD maps it to "A")
assert.notEqual(CAFE_NFC, CAFE_NFD);
assert.equal(CAFE_NFC.normalize("NFKD"), CAFE_NFD);

// --- independent reference: BIP39 seed + BIP32 private derivation --------------------------------
const N = secp256k1.Point.CURVE().n;
const hex = (bytes) => Buffer.from(bytes).toString("hex");
function referenceSeed(phrase, passphrase) {
  return pbkdf2Sync(Buffer.from(phrase.normalize("NFKD"), "utf8"), Buffer.from(("mnemonic" + passphrase).normalize("NFKD"), "utf8"), 2048, 64, "sha512");
}
function referenceKeyAt(seed, path) {
  let I = createHmac("sha512", "Bitcoin seed").update(seed).digest();
  let k = BigInt("0x" + hex(I.subarray(0, 32)));
  let c = I.subarray(32);
  for (const part of path.replace(/^m\//, "").split("/")) {
    const hardened = part.endsWith("'");
    const i = (Number.parseInt(part, 10) + (hardened ? 0x80000000 : 0)) >>> 0;
    const kBytes = Buffer.from(k.toString(16).padStart(64, "0"), "hex");
    const data = hardened
      ? Buffer.concat([Buffer.from([0]), kBytes])
      : Buffer.from(secp256k1.getPublicKey(kBytes, true));
    const index = Buffer.alloc(4); index.writeUInt32BE(i);
    I = createHmac("sha512", c).update(Buffer.concat([data, index])).digest();
    k = (BigInt("0x" + hex(I.subarray(0, 32))) + k) % N;
    c = I.subarray(32);
  }
  return k.toString(16).padStart(64, "0");
}
const addressOf = (privateKeyHex) => new kaspa.PrivateKey(privateKeyHex).toAddress(NETWORK_ID).toString();
const referenceAddress = (passphrase, path) => addressOf(referenceKeyAt(referenceSeed(PHRASE, passphrase), path));

// --- what the pre-EXT-010 code did: the passphrase straight into the WASM ------------------------
function oldCodeKeyAt(passphrase, path) {
  const seed = new kaspa.Mnemonic(PHRASE).toSeed(passphrase);
  return new kaspa.XPrv(seed).derivePath(path).toPrivateKey().toString();
}
const oldCodeAddress = (passphrase, path) => addressOf(oldCodeKeyAt(passphrase, path));

const IDENTITY_0 = "m/44'/111111'/0'/0/0";
const SPENDING = (i) => `m/44'/111111'/1'/0/${i}`;
const LEGACY972_0 = "m/44'/972/0'/0'/0'";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("helpers: seedPassphrase / passphraseIsNfkd / normalizePassphraseForm", () => {
  assert.deepEqual(PASSPHRASE_FORMS, ["nfkd", "raw"]);
  assert.equal(seedPassphrase(CAFE_NFC), CAFE_NFD);
  assert.equal(seedPassphrase(CAFE_NFD), CAFE_NFD);
  assert.equal(seedPassphrase(CAFE_NFC, { legacy: true }), CAFE_NFC);
  assert.equal(seedPassphrase("Ａ"), "A"); // compatibility mapping, not just canonical
  assert.equal(seedPassphrase(null), "");
  assert.equal(seedPassphrase(undefined, { legacy: true }), "");
  assert.equal(passphraseIsNfkd("TREZOR"), true);
  assert.equal(passphraseIsNfkd(""), true);
  assert.equal(passphraseIsNfkd(CAFE_NFD), true);
  assert.equal(passphraseIsNfkd(CAFE_NFC), false);
  assert.equal(normalizePassphraseForm("raw"), "raw");
  for (const other of ["nfkd", "", undefined, null, "RAW", "nfc"]) assert.equal(normalizePassphraseForm(other), "nfkd");
});

test("saved-account rule: passphraseFormForRecord", () => {
  assert.equal(passphraseFormForRecord(null), "nfkd");
  assert.equal(passphraseFormForRecord({}), "nfkd");
  assert.equal(passphraseFormForRecord({ passphrase: "" }), "nfkd");
  assert.equal(passphraseFormForRecord({ passphrase: "TREZOR" }), "nfkd"); // ASCII: no flag needed
  assert.equal(passphraseFormForRecord({ passphrase: CAFE_NFD }), "nfkd"); // new records store NFKD
  assert.equal(passphraseFormForRecord({ passphrase: CAFE_NFC }), "raw"); // OLD record, no flag
  assert.equal(passphraseFormForRecord({ passphrase: CAFE_NFC, passphraseForm: "raw" }), "raw");
  assert.equal(passphraseFormForRecord({ passphrase: CAFE_NFC, passphraseForm: "nfkd" }), "nfkd"); // the flag wins
  assert.equal(passphraseFormForRecord({ passphrase: "", passphraseForm: "raw" }), "raw"); // locked view: flag only
  assert.equal(passphraseFormForRecord({ passphrase: CAFE_NFC, passphraseForm: "bogus" }), "raw");
});

test("BIP39 vector: TREZOR seed matches the published one", () => {
  const vector = "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04";
  assert.equal(hex(referenceSeed(PHRASE, "TREZOR")), vector);
  assert.equal(String(new kaspa.Mnemonic(PHRASE).toSeed("TREZOR")), vector);
});

test("the WASM itself does not normalize (why EXT-010 exists)", () => {
  const nfc = String(new kaspa.Mnemonic(PHRASE).toSeed(CAFE_NFC));
  const nfd = String(new kaspa.Mnemonic(PHRASE).toSeed(CAFE_NFD));
  assert.notEqual(nfc, nfd);
  assert.equal(nfd, hex(referenceSeed(PHRASE, CAFE_NFC)));
});

test("importMnemonic: café composed == decomposed == BIP39 reference", () => {
  const a = importMnemonic(kaspa, PHRASE, CAFE_NFC);
  const b = importMnemonic(kaspa, PHRASE, CAFE_NFD);
  const c = importMnemonic(kaspa, PHRASE, CAFE_NFC, { passphraseForm: "nfkd" });
  assert.equal(a.address, b.address);
  assert.equal(a.address, c.address);
  assert.equal(a.privateKeyHex, referenceKeyAt(referenceSeed(PHRASE, CAFE_NFC), IDENTITY_0));
  assert.equal(a.address, referenceAddress(CAFE_NFD, IDENTITY_0));
  assert.notEqual(a.address, oldCodeAddress(CAFE_NFC, IDENTITY_0)); // the bug, fixed
  assert.equal(a.hasPassphrase, true);
});

test("importMnemonic: a \"raw\" account still derives the old address", () => {
  const raw = importMnemonic(kaspa, PHRASE, CAFE_NFC, { passphraseForm: "raw" });
  assert.equal(raw.privateKeyHex, oldCodeKeyAt(CAFE_NFC, IDENTITY_0));
  assert.notEqual(raw.address, importMnemonic(kaspa, PHRASE, CAFE_NFC).address);
  // A raw account with an already-NFKD passphrase is the same wallet as the standard.
  assert.equal(importMnemonic(kaspa, PHRASE, CAFE_NFD, { passphraseForm: "raw" }).address, importMnemonic(kaspa, PHRASE, CAFE_NFD).address);
});

test("importMnemonicWithFamily: all families, both forms, against the reference", async () => {
  for (const [family, path] of [["kaspaStandard", IDENTITY_0], ["kaspaLegacy972", LEGACY972_0], ["oneKey", IDENTITY_0]]) {
    const tweak = async (k) => (family === "oneKey" ? oneKeyTweakPrivateKeyHex(kaspa, k) : k);
    const nfc = await importMnemonicWithFamily(kaspa, PHRASE, GRUSSE_NFC, { family });
    const nfkd = await importMnemonicWithFamily(kaspa, PHRASE, GRUSSE_NFC.normalize("NFKD"), { family });
    assert.equal(nfc.address, nfkd.address, `${family}: composed == decomposed`);
    assert.equal(nfc.privateKeyHex, await tweak(referenceKeyAt(referenceSeed(PHRASE, GRUSSE_NFC), path)), `${family}: reference`);
    const raw = await importMnemonicWithFamily(kaspa, PHRASE, GRUSSE_NFC, { family, passphraseForm: "raw" });
    assert.equal(raw.privateKeyHex, await tweak(oldCodeKeyAt(GRUSSE_NFC, path)), `${family}: raw == old code`);
    assert.notEqual(raw.address, nfc.address, `${family}: raw differs`);
    const asciiStd = await importMnemonicWithFamily(kaspa, PHRASE, "TREZOR", { family });
    const asciiRaw = await importMnemonicWithFamily(kaspa, PHRASE, "TREZOR", { family, passphraseForm: "raw" });
    assert.equal(asciiStd.address, asciiRaw.address, `${family}: ASCII same either way`);
    assert.equal(asciiStd.privateKeyHex, await tweak(oldCodeKeyAt("TREZOR", path)), `${family}: ASCII unchanged from old code`);
  }
});

test("deriveIdentityAddressRange: standard and raw, against single derivations", async () => {
  const std = await deriveIdentityAddressRange(kaspa, PHRASE, CAFE_NFC, { start: 0, count: 3 });
  const stdNfd = await deriveIdentityAddressRange(kaspa, PHRASE, CAFE_NFD, { start: 0, count: 3 });
  const raw = await deriveIdentityAddressRange(kaspa, PHRASE, CAFE_NFC, { start: 0, count: 3, passphraseForm: "raw" });
  assert.deepEqual(std, stdNfd);
  for (let i = 0; i < 3; i += 1) {
    const path = `m/44'/111111'/0'/0/${i}`;
    assert.equal(std[i].address, referenceAddress(CAFE_NFC, path));
    assert.equal(raw[i].address, oldCodeAddress(CAFE_NFC, path));
  }
  const ascii = await deriveIdentityAddressRange(kaspa, PHRASE, "TREZOR", { count: 2 });
  assert.deepEqual(ascii, await deriveIdentityAddressRange(kaspa, PHRASE, "TREZOR", { count: 2, passphraseForm: "raw" }));
});

test("deriveSpendingWallet: standard, raw and ASCII", () => {
  for (const i of [0, 1, 7]) {
    const a = deriveSpendingWallet(kaspa, PHRASE, i, CAFE_NFC);
    const b = deriveSpendingWallet(kaspa, PHRASE, i, CAFE_NFD, { passphraseForm: "nfkd" });
    assert.equal(a.address, b.address);
    assert.equal(a.privateKeyHex, referenceKeyAt(referenceSeed(PHRASE, CAFE_NFC), SPENDING(i)));
    const raw = deriveSpendingWallet(kaspa, PHRASE, i, CAFE_NFC, { passphraseForm: "raw" });
    assert.equal(raw.privateKeyHex, oldCodeKeyAt(CAFE_NFC, SPENDING(i)));
    assert.notEqual(raw.address, a.address);
    const asciiStd = deriveSpendingWallet(kaspa, PHRASE, i, "TREZOR");
    const asciiRaw = deriveSpendingWallet(kaspa, PHRASE, i, "TREZOR", { passphraseForm: "raw" });
    assert.equal(asciiStd.address, asciiRaw.address);
    assert.equal(asciiStd.privateKeyHex, oldCodeKeyAt("TREZOR", SPENDING(i)));
  }
  // No passphrase: unchanged.
  assert.equal(deriveSpendingWallet(kaspa, PHRASE, 0).privateKeyHex, oldCodeKeyAt("", SPENDING(0)));
});

test("generateMnemonicWallet: new accounts derive the standard", () => {
  const created = generateMnemonicWallet(kaspa, 12, CAFE_NFC);
  assert.equal(created.address, importMnemonic(kaspa, created.mnemonic, CAFE_NFD).address);
});

test("key vault: passphraseForm is public, survives sealing and is readable while locked", async () => {
  class MemoryStorage {
    constructor() { this.map = new Map(); }
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
    setItem(key, value) { this.map.set(key, String(value)); }
    removeItem(key) { this.map.delete(key); }
    get length() { return this.map.size; }
    key(index) { return [...this.map.keys()][index] ?? null; }
  }
  const local = new MemoryStorage();
  configureKeyVault({ storage: local, session: new MemoryStorage(), iterations: 2_000, canonicalize: (a) => String(a || "").trim().toLowerCase() });
  const raw = importMnemonic(kaspa, PHRASE, CAFE_NFC, { passphraseForm: "raw" });
  writeAccountRecords([{ version: 1, address: raw.address, privateKeyHex: raw.privateKeyHex, mnemonic: PHRASE, passphrase: CAFE_NFC, passphraseForm: "raw", name: "Old" }]);
  await setAppPassword("correct horse battery");
  assert.ok(!local.getItem("kachat-saved-accounts-v1").includes(PHRASE), "sealed");
  lockKeyVault();
  const locked = readAccountRecords()[0];
  assert.equal(locked.locked, true);
  assert.equal(locked.passphrase, undefined);
  assert.equal(locked.passphraseForm, "raw");
  assert.equal(passphraseFormForRecord(locked), "raw");
  assert.equal(await unlockKeyVault("correct horse battery"), true);
  const open = readAccountRecords()[0];
  assert.equal(open.passphrase, CAFE_NFC); // stored as typed: the raw account keeps its bytes
  assert.equal(passphraseFormForRecord(open), "raw");
  assert.equal(importMnemonic(kaspa, open.mnemonic, open.passphrase, { passphraseForm: passphraseFormForRecord(open) }).address, raw.address);
  lockKeyVault();
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error?.stack || error}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
