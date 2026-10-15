// Amount fields show thousands commas as you type ("12,345.5", or "12 345,5" where "," is the
// decimal point - iOS b383ff0) while the value the app reads stays
// plain (iOS 40c5258: KaspaAmountEntry and Binding.groupedAmount). Each field's `value` is
// wrapped: reading it gives the plain number, writing it shows the grouped one, so the code
// that sanitizes, checks and sends an amount is unchanged.

import { groupedAmountText as groupedWith, ungroupedAmountText as ungroupedWith, usesCommaDecimal } from "../engine/amounts.js";

// This browser's number style, read once: where "," is the decimal point it always is one, and
// thousands show as a thin space (iOS 73af28a).
const style = { commaDecimal: usesCommaDecimal(typeof navigator !== "undefined" ? navigator.language : undefined) };
const groupedAmountText = (plain) => groupedWith(plain, style);
const ungroupedAmountText = (edited, previous) => ungroupedWith(edited, previous, style);

// The send screens' amount (Send Kaspa, a spending address's Send, the chat's Send KAS, Cold
// Storage, tips, Request Payment), the .kachat offer and list price, and a portfolio entry's
// amount and price. The portfolio converter keeps its own formatting, as on iOS.
const SELECTOR = ".sk-amount-input, .kl-amount-input, .kmkt-amount-input, "
  + "[data-portfolio-editor-amount], [data-portfolio-editor-price]";

const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
const wrapped = new WeakSet();

function attach(input) {
  if (wrapped.has(input)) return;
  wrapped.add(input);
  const getShown = () => native.get.call(input);
  // What the field showed before the edit in progress: how a typed comma is told apart from ours.
  let lastShown = groupedAmountText(getShown());
  const show = (text) => { lastShown = text; native.set.call(input, text); };
  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => ungroupedAmountText(getShown(), lastShown),
    set: (plain) => show(groupedAmountText(String(plain ?? ""))),
  });
  show(lastShown);
  // Runs before the page's own input handlers (capture), so they see the regrouped field.
  input.addEventListener("input", () => {
    const edited = getShown();
    const caret = input.selectionStart ?? edited.length;
    const plain = ungroupedAmountText(edited, lastShown);
    const next = groupedAmountText(plain);
    if (next === edited) { lastShown = next; return; }
    // Keep the caret after the same digit (separators come and go around it), and after the
    // decimal point when that is what was just typed.
    let keep = 0;
    for (let i = 0; i < caret; i += 1) if (edited[i] >= "0" && edited[i] <= "9") keep += 1;
    const typedDecimal = caret > 0 && (edited[caret - 1] === "." || edited[caret - 1] === ",") && plain.includes(".");
    show(next);
    let at = next.length;
    if (caret < edited.length) {
      at = 0;
      for (let seen = 0; at < next.length && seen < keep; at += 1) if (next[at] >= "0" && next[at] <= "9") seen += 1;
      if (typedDecimal && (next[at] === "." || next[at] === ",")) at += 1;
    }
    try { input.setSelectionRange(at, at); } catch { /* not focusable */ }
  }, true);
}

function scan(node) {
  if (!(node instanceof Element)) return;
  if (node.matches(SELECTOR)) attach(node);
  for (const input of node.querySelectorAll(SELECTOR)) attach(input);
}

/** Wraps every amount field now on the page and each one added later. */
export function installGroupedAmountInputs(root = document.documentElement) {
  scan(root);
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) scan(node);
  }).observe(root, { childList: true, subtree: true });
}
