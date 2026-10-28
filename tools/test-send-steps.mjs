// The step-by-step send's keypad (ui/send-steps.js, KaPay 05db583 KaspaKeypad.applying).
import assert from "node:assert/strict";
import { applyKeypadKey, keypadKeyForKeyboard, keypadFontSize } from "../ui/send-steps.js";

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

check("digits append; a leading zero gives way", () => {
  assert.equal(applyKeypadKey("5", ""), "5");
  assert.equal(applyKeypadKey("5", "0"), "5");
  assert.equal(applyKeypadKey("0", "12"), "120");
});
check("the point writes 0. on an empty amount, once only", () => {
  assert.equal(applyKeypadKey("decimal", ""), "0.");
  assert.equal(applyKeypadKey("decimal", "3"), "3.");
  assert.equal(applyKeypadKey("decimal", "3.1"), "3.1");
  assert.equal(applyKeypadKey("decimal", "3", 0), "3");
});
check("at most maxDecimals decimals and 11 whole digits", () => {
  assert.equal(applyKeypadKey("9", "1.12345678", 8), "1.12345678");
  assert.equal(applyKeypadKey("9", "1.12", 2), "1.12");
  assert.equal(applyKeypadKey("9", "1.1", 2), "1.19");
  assert.equal(applyKeypadKey("7", "12345678901"), "12345678901");
});
check("delete drops one character, clear empties", () => {
  assert.equal(applyKeypadKey("delete", "12.5"), "12.");
  assert.equal(applyKeypadKey("delete", ""), "");
  assert.equal(applyKeypadKey("clear", "12.5"), "");
});
check("an unknown key changes nothing", () => {
  assert.equal(applyKeypadKey("x", "12"), "12");
});
check("a keyboard's digits, point and Backspace map to keys", () => {
  assert.equal(keypadKeyForKeyboard({ key: "7" }), "7");
  assert.equal(keypadKeyForKeyboard({ key: "," }), "decimal");
  assert.equal(keypadKeyForKeyboard({ key: "Backspace" }), "delete");
  assert.equal(keypadKeyForKeyboard({ key: "Delete" }), "clear");
  assert.equal(keypadKeyForKeyboard({ key: "v", metaKey: true }), null);
  assert.equal(keypadKeyForKeyboard({ key: "a" }), null);
});
check("the typed amount shrinks as it grows (iOS 60 / 46 / 34)", () => {
  assert.equal(keypadFontSize("1,234"), 60);
  assert.equal(keypadFontSize("1,234,567"), 46);
  assert.equal(keypadFontSize("12,345,678.9"), 34);
});

console.log(`\n${passed} passed`);
