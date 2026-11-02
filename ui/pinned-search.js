// The search field above a list (KaChat-iPhone d063b897 PinnedListHeader): the clear mark while it
// has text, Cancel beside it while it has focus, and scrolling the list lets go of the keyboard
// (.scrollDismissesKeyboard(.immediately)). Delegated from `root`, which stays when its list is
// redrawn. Markup: .pinned-search > input + [data-pinned-search-clear], [data-pinned-search-cancel].

function sync(box) {
  const input = box?.querySelector("input");
  if (!input) return;
  const clear = box.querySelector("[data-pinned-search-clear]");
  const cancel = box.querySelector("[data-pinned-search-cancel]");
  if (clear) clear.hidden = !input.value;
  if (cancel) cancel.hidden = document.activeElement !== input;
}

function setValue(input, value) {
  if (input.value === value) return;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function attachPinnedSearch(root) {
  if (!root) return;
  const boxOf = (event) => (event.target instanceof Element ? event.target.closest(".pinned-search") : null);
  root.addEventListener("focusin", (event) => sync(boxOf(event)));
  root.addEventListener("focusout", (event) => sync(boxOf(event)));
  root.addEventListener("input", (event) => sync(boxOf(event)));
  // Pressing either must not take the focus first: Cancel would hide before its click landed.
  root.addEventListener("mousedown", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-pinned-search-clear], [data-pinned-search-cancel]")) event.preventDefault();
  });
  root.addEventListener("click", (event) => {
    const box = boxOf(event);
    const input = box?.querySelector("input");
    if (!input || !(event.target instanceof Element)) return;
    if (event.target.closest("[data-pinned-search-clear]")) {
      setValue(input, "");
      input.focus();
    } else if (event.target.closest("[data-pinned-search-cancel]")) {
      setValue(input, "");
      input.blur();
    }
    sync(box);
  });
  // A finger moving on the list, not a scroll event: filtering the list while typing moves it too,
  // and that must not take the keyboard away.
  root.addEventListener("touchmove", (event) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.matches(".pinned-search input") || !root.contains(active)) return;
    if (event.target instanceof Element && event.target.closest(".pinned-search")) return;
    active.blur();
  }, { passive: true });
}
