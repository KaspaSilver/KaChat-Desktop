// Step-by-step sends (KaPay 05db583, KaChat-iPhone bc3e1ff3): every screen that moves Kaspa asks one
// thing at a time - To, From, Amount on the app's own keypad - then the swipe-up Review, where only
// the fee (its Edit opens the fee editor) and coin control can change. The pieces iOS shares in
// SendKaspaComponents (SendStepScreen / Header / Question / Chip, SendContinueButton, KaspaKeypad,
// KeypadAmountText, SendFeeEditorScreen) live here; the Review is the swipe-up screen itself
// (send-kaspa-components.js createSwipeUpScreen).

import { escapeSendHtml as esc, formatSompiPlain, shortSendAddress } from "./send-kaspa-components.js";
import { groupedAmountText, sompiFromUserText } from "../engine/amounts.js";

const ICONS = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 5.5H20a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H8.6L2.5 12z"/><path d="m11.5 9.5 5 5M16.5 9.5l-5 5"/></svg>',
};

// --- Keypad (iOS KaspaKeypad) --------------------------------------------------------------------

const KEYPAD_ROWS = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["decimal", "0", "delete"]];

/** Whether this device writes "," for the decimal point (iOS KaspaAmountEntry.usesCommaDecimal). */
export function usesCommaDecimal() {
  try { return (1.5).toLocaleString(undefined, { minimumFractionDigits: 1 }).includes(","); } catch { return false; }
}

/**
 * The amount text after a key (iOS KaspaKeypad.applying): plain digits with "." as the point, at
 * most `maxDecimals` decimals and 11 whole digits (more than all the Kaspa there will ever be). A
 * leading zero gives way to the next digit; the point on an empty amount writes "0.". A key that
 * can't apply leaves the text as it was. Keys: "0"-"9", "decimal", "delete", "clear".
 */
export function applyKeypadKey(key, text, maxDecimals = 8) {
  const current = String(text ?? "");
  if (key === "clear") return "";
  if (key === "delete") return current.slice(0, -1);
  if (key === "decimal") {
    if (current.includes(".") || maxDecimals <= 0) return current;
    return current ? `${current}.` : "0.";
  }
  if (!/^[0-9]$/.test(String(key))) return current;
  const point = current.indexOf(".");
  if (point >= 0) return current.length - point - 1 >= maxDecimals ? current : current + key;
  if (current === "0") return String(key);
  if (current.length >= 11) return current;
  return current + key;
}

/** The keys a physical keyboard types into a keypad: digits, "." / ",", Backspace (Delete clears). */
export function keypadKeyForKeyboard(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (/^[0-9]$/.test(event.key)) return event.key;
  if (event.key === "." || event.key === ",") return "decimal";
  if (event.key === "Backspace") return "delete";
  if (event.key === "Delete") return "clear";
  return null;
}

export function keypadHtml() {
  const point = usesCommaDecimal() ? "," : ".";
  const label = (key) => (key === "decimal" ? "Decimal point" : key === "delete" ? "Delete" : key);
  const face = (key) => (key === "decimal" ? point : key === "delete" ? ICONS.delete : key);
  return `<div class="ss-keypad" role="group" aria-label="Keypad">${KEYPAD_ROWS.flat().map((key) =>
    `<button type="button" class="ss-key" data-ss-key="${key}" aria-label="${esc(label(key))}">${face(key)}</button>`).join("")}</div>`;
}

/**
 * Wires a mounted keypad: a press calls `onKey(key)` (hold delete to clear, as iOS), and while the
 * keypad is on screen and no text field has focus, the keyboard's digits, point and Backspace type
 * into it too - a desktop has a keyboard. `onKey` returns false when the key changed nothing (the
 * key then shakes, iOS's rigid haptic).
 */
export function wireKeypad(keypad, onKey) {
  if (!keypad) return;
  let holdTimer = null;
  let held = false;
  const press = (key, button) => {
    if (onKey(key) === false && button) {
      button.classList.remove("ss-key-refused");
      void button.offsetWidth;
      button.classList.add("ss-key-refused");
    }
  };
  keypad.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-ss-key='delete']");
    if (!button) return;
    held = false;
    holdTimer = setTimeout(() => { holdTimer = null; held = true; press("clear", button); }, 500);
  });
  const stopHold = () => { if (holdTimer) clearTimeout(holdTimer); holdTimer = null; };
  keypad.addEventListener("pointerup", stopHold);
  keypad.addEventListener("pointercancel", stopHold);
  keypad.addEventListener("pointerleave", stopHold);
  keypad.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ss-key]");
    if (!button) return;
    const key = button.getAttribute("data-ss-key");
    if (key === "delete" && held) { held = false; return; }
    press(key, button);
  });
  window.addEventListener("keydown", (event) => {
    if (!keypad.isConnected || !keypad.offsetParent || keypad.closest("[hidden]")) return;
    const target = event.target;
    if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
    // A picker or dialog open over the step owns the keyboard.
    const open = [...document.querySelectorAll(".modal-backdrop:not([hidden])")];
    const mine = keypad.closest(".modal-backdrop");
    if (mine && open.length && open[open.length - 1] !== mine) return;
    const key = keypadKeyForKeyboard(event);
    if (!key) return;
    event.preventDefault();
    press(key, keypad.querySelector(`[data-ss-key="${key === "clear" ? "delete" : key}"]`));
  });
}

/** Big when short, smaller as it grows (iOS KeypadAmountText: 60 / 46 / 34 pt). */
export function keypadFontSize(text) {
  const length = String(text || "").length;
  return length <= 7 ? 60 : (length <= 10 ? 46 : 34);
}

/** The big number a keypad types into (iOS KeypadAmountText): grouped, "0" while empty, its unit. */
export function keypadAmountTextHtml({ typed = "", unit = "KAS", attr = "" } = {}) {
  const display = typed ? groupedAmountText(typed, { commaDecimal: usesCommaDecimal() }) : "0";
  const size = keypadFontSize(display);
  return `<div class="ss-amount${typed ? "" : " empty"}" ${attr ? `data-${attr}` : ""} role="status" aria-live="polite">
    <span class="ss-amount-number" style="font-size:${size}px">${esc(display)}</span>
    <span class="ss-amount-unit" style="font-size:${Math.round(size * 0.5)}px">${esc(unit)}</span>
  </div>`;
}

/** Repaints a mounted keypad amount (the element `keypadAmountTextHtml` made). */
export function paintKeypadAmount(el, typed, unit) {
  if (!el) return;
  const display = typed ? groupedAmountText(typed, { commaDecimal: usesCommaDecimal() }) : "0";
  const size = keypadFontSize(display);
  el.classList.toggle("empty", !typed);
  const number = el.querySelector(".ss-amount-number");
  const unitEl = el.querySelector(".ss-amount-unit");
  if (number) { number.textContent = display; number.style.fontSize = `${size}px`; }
  if (unitEl) { if (unit != null) unitEl.textContent = unit; unitEl.style.fontSize = `${Math.round(size * 0.5)}px`; }
}

// --- Small pieces ---------------------------------------------------------------------------------

/** "To alice.kachat", "From Chatting Address" (iOS SendStepChip); an address is cut in the middle. */
export function stepChipHtml({ label, value, isAddress = false, attr = "" } = {}) {
  const shown = isAddress ? shortSendAddress(value) : String(value || "");
  return `<span class="ss-chip" ${attr ? `data-${attr}` : ""} title="${esc(value || "")}"><span class="ss-chip-label">${esc(label)}</span><span class="ss-chip-value${isAddress ? " mono" : ""}">${esc(shown)}</span></span>`;
}

/** The question a step asks, big, at the top (iOS SendStepQuestion). */
export function stepQuestionHtml(text) {
  return `<h3 class="ss-question">${esc(text)}</h3>`;
}

/** One review line (iOS reviewRow): the label on the left, the value (trusted markup) on the right. */
export function reviewRowHtml(label, valueHtml) {
  return `<div class="ss-review-row"><span class="ss-review-label">${esc(label)}</span><span class="ss-review-value">${valueHtml}</span></div>`;
}

/** A review's address value: the name over the address, or the address alone. */
export function reviewAddressHtml({ name = null, address = "" } = {}) {
  return `${name ? `<strong>${esc(name)}</strong>` : ""}<code class="ss-review-address" title="${esc(address)}">${esc(shortSendAddress(address))}</code>`;
}

// --- The step screens ----------------------------------------------------------------------------

/**
 * The steps of one send, drawn over a swipe-up sheet (`card`, already a `createSwipeUpScreen` host):
 * each step is a full-sheet screen - its header (Back and Cancel, or the title alone on a first
 * step), the step's content, and Continue pinned at the bottom (beside Cancel on a first step, iOS
 * SendStepScreen). `go("review")` uncovers the swipe-up screen underneath; any other id shows that
 * step, sliding in from the side it comes from.
 *
 * `addStep(id, { question, continueTitle, canContinue, onContinue, back, onShow, className })`
 * returns the step's body to fill. `back()` names the step Back goes to (null: a first step);
 * `canContinue()` is read on `refresh()`.
 */
export function createStepFlow(card, { title = "Send Kaspa", onCancel } = {}) {
  const steps = new Map();
  const order = [];
  let current = null;
  let screenTitle = title;
  const layer = document.createElement("div");
  layer.className = "ss-layer";
  layer.hidden = true;
  card?.appendChild(layer);

  function paintHeader(step) {
    const back = step.config.back?.() ?? null;
    step.el.classList.toggle("ss-first", back == null);
    step.backButton.hidden = back == null;
    step.headCancel.hidden = back == null;
    step.barCancel.hidden = back != null;
    step.titleEl.textContent = step.config.title?.() ?? screenTitle;
  }
  function refresh() {
    for (const step of steps.values()) {
      const ok = Boolean(step.config.canContinue?.() ?? true);
      step.continueButton.disabled = !ok;
      if (step.config.continueTitle) step.continueButton.textContent = typeof step.config.continueTitle === "function" ? step.config.continueTitle() : step.config.continueTitle;
    }
    const step = steps.get(current);
    if (step) paintHeader(step);
  }
  // A screen slides in from the side it comes from and the one it replaces slides out the other way;
  // to and from the review the whole layer slides, uncovering or covering the swipe-up screen.
  function slideIn(el, from) {
    delete el.dataset.leaving;
    el.dataset.entering = from;
    void el.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => { delete el.dataset.entering; }));
  }
  function slideOut(el, to, done) {
    delete el.dataset.entering;
    el.dataset.leaving = to;
    const mark = `${to}:${Date.now()}`;
    el.dataset.leavingMark = mark;
    setTimeout(() => {
      if (el.dataset.leavingMark !== mark) return;
      delete el.dataset.leaving;
      delete el.dataset.leavingMark;
      done();
    }, 320);
  }
  function go(id, { instant = false } = {}) {
    const previous = current;
    current = id;
    const animate = !instant && previous != null && previous !== id;
    const forward = order.indexOf(id) > order.indexOf(previous);
    const target = steps.get(id) || null; // none: the review underneath
    const leaving = previous !== id ? (steps.get(previous) || null) : null;
    for (const step of steps.values()) {
      if (step === target || step === leaving) continue;
      step.el.hidden = true;
      delete step.el.dataset.entering;
      delete step.el.dataset.leaving;
    }
    if (!target) {
      if (leaving && animate) slideOut(layer, forward ? "left" : "right", () => { if (!steps.has(current)) { layer.hidden = true; leaving.el.hidden = true; } });
      else { layer.hidden = true; if (leaving) leaving.el.hidden = true; }
      return;
    }
    layer.hidden = false;
    target.el.hidden = false;
    if (!leaving) {
      if (animate) slideIn(layer, forward ? "right" : "left");
      else { delete layer.dataset.entering; delete layer.dataset.leaving; delete layer.dataset.leavingMark; }
    } else if (animate) {
      delete layer.dataset.leaving;
      delete layer.dataset.leavingMark;
      slideIn(target.el, forward ? "right" : "left");
      slideOut(leaving.el, forward ? "left" : "right", () => { if (current !== previous) leaving.el.hidden = true; });
    } else {
      leaving.el.hidden = true;
    }
    target.body.scrollTop = 0;
    refresh();
    try { target.config.onShow?.(); } catch { /* the screen reports its own errors */ }
  }

  return {
    layer,
    addStep(id, config = {}) {
      const el = document.createElement("section");
      el.className = `ss-step${config.className ? ` ${config.className}` : ""}`;
      el.hidden = true;
      el.dataset.ssStep = id;
      el.innerHTML = `
        <header class="ss-head">
          <button type="button" class="ss-back" data-ss-back aria-label="Back">${ICONS.back}</button>
          <h2 class="ss-title" data-ss-title></h2>
          <button type="button" class="ss-cancel" data-ss-head-cancel>Cancel</button>
        </header>
        <div class="ss-body" data-ss-body>${config.question ? stepQuestionHtml(config.question) : ""}</div>
        <div class="ss-bar">
          <button type="button" class="ss-bar-cancel" data-ss-bar-cancel>Cancel</button>
          <button type="button" class="ss-continue" data-ss-continue>${esc(typeof config.continueTitle === "string" ? config.continueTitle : "Continue")}</button>
        </div>`;
      layer.appendChild(el);
      const step = {
        el, config,
        body: el.querySelector("[data-ss-body]"),
        titleEl: el.querySelector("[data-ss-title]"),
        backButton: el.querySelector("[data-ss-back]"),
        headCancel: el.querySelector("[data-ss-head-cancel]"),
        barCancel: el.querySelector("[data-ss-bar-cancel]"),
        continueButton: el.querySelector("[data-ss-continue]"),
      };
      step.backButton.addEventListener("click", () => { const back = config.back?.(); if (back) go(back); });
      const cancel = () => (config.onCancel || onCancel)?.();
      step.headCancel.addEventListener("click", cancel);
      step.barCancel.addEventListener("click", cancel);
      step.continueButton.addEventListener("click", () => {
        if (step.continueButton.disabled) return;
        config.onContinue?.();
      });
      steps.set(id, step);
      order.push(id);
      return step.body;
    },
    /** Puts `id` in the order steps slide by (the review sits after the steps that come before it). */
    setOrder(ids) { order.length = 0; order.push(...ids); },
    go,
    refresh,
    setTitle(text) { screenTitle = String(text || ""); refresh(); },
    get current() { return current; },
    stepBody(id) { return steps.get(id)?.body || null; },
  };
}

// --- Fee editor (iOS SendFeeEditorScreen) ---------------------------------------------------------

/**
 * A review's fee editor (its fee row's Edit), as a step of `flow`: the whole network fee typed on
 * the keypad, Confirm hands it back, Cancel leaves it as it was and goes back to the review. Says
 * the network's minimum when known and warns at more than ten times it (else the fee it opened
 * with). `open({ feeSompi, minimumSompi, kasUnit })`; `onConfirm(sompi)` gets the typed fee.
 */
export function createFeeEditorStep(flow, { onConfirm, reviewId = "review" } = {}) {
  let draft = "";
  let minimum = null;
  let reference = null;
  let unit = "KAS";
  const body = flow.addStep("fee", {
    title: () => "Network Fee",
    continueTitle: "Confirm",
    className: "ss-fee-step",
    back: () => null,
    onCancel: () => flow.go(reviewId),
    canContinue: () => draftSompi() != null,
    onContinue: () => {
      const sompi = draftSompi();
      if (sompi == null) return;
      flow.go(reviewId);
      onConfirm?.(sompi);
    },
  });
  body.innerHTML = `
    <h3 class="ss-question ss-center">Set your network fee</h3>
    <div class="ss-keypad-stage">
      ${keypadAmountTextHtml({ unit, attr: "ss-fee-amount" })}
      <p class="ss-footnote" data-ss-fee-note>&nbsp;</p>
    </div>
    ${keypadHtml()}`;
  const amountEl = body.querySelector("[data-ss-fee-amount]");
  const note = body.querySelector("[data-ss-fee-note]");
  function draftSompi() {
    const sompi = sompiFromUserText(draft);
    return sompi != null && sompi > 0n ? sompi : null;
  }
  function paint() {
    paintKeypadAmount(amountEl, draft, unit);
    const typed = draftSompi();
    const base = minimum ?? reference;
    const high = typed != null && base != null && base > 0n && typed > base * 10n;
    const minimumText = minimum != null ? `The network needs at least ${formatSompiPlain(minimum)} ${unit}. A lower fee is raised to that.` : "";
    note.textContent = (high ? ["This is much more than the network needs.", minimumText].filter(Boolean).join(" ") : minimumText) || " ";
    note.classList.toggle("warn", high);
    flow.refresh();
  }
  wireKeypad(body.querySelector(".ss-keypad"), (key) => {
    const next = applyKeypadKey(key, draft, 8);
    if (next === draft) return false;
    draft = next;
    paint();
    return true;
  });
  return {
    open({ feeSompi = null, minimumSompi = null, kasUnit = "KAS" } = {}) {
      unit = kasUnit;
      minimum = minimumSompi != null ? BigInt(minimumSompi) : null;
      reference = feeSompi != null ? BigInt(feeSompi) : null;
      draft = feeSompi != null ? formatSompiPlain(feeSompi) : "";
      flow.go("fee");
      paint();
    },
  };
}
