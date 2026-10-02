// KaChat Wallet's bridge between a web page and the extension (the content script's isolated
// world). It passes window.kachat calls to the background, which knows - from the browser, not
// from the page - which site is asking, and it tells the page when its connection changes.
(() => {
  const CHANNEL = "kachat-wallet";
  // `chrome` first: recent Chromium's separate `browser` namespace drops sendResponse answers.
  const api = globalThis.chrome?.runtime ? globalThis.chrome : globalThis.browser;
  // Connections are kept per network ("kachat.connections" / "kachat.connections.testnet").
  const CONNECTION_KEYS = ["kachat.connections", "kachat.connections.testnet"];
  const origin = window.location.origin;

  const toPage = (message) => window.postMessage({ channel: CHANNEL, direction: "to-page", ...message }, origin);

  window.addEventListener("message", (event) => {
    const data = event.data;
    // Only the page itself - never a frame posting into it.
    if (event.source !== window || !data || data.channel !== CHANNEL || data.direction !== "to-content") return;
    if (typeof data.id !== "string" || typeof data.method !== "string") return;
    const params = Array.isArray(data.params) ? data.params.slice(0, 4) : [];
    let reply;
    try {
      reply = api.runtime.sendMessage({ type: "dapp-request", method: data.method, params });
    } catch {
      toPage({ id: data.id, error: { code: 4900, message: "KaChat Wallet was updated - reload this page." } });
      return;
    }
    Promise.resolve(reply)
      .then((response) => toPage({ id: data.id, ...(response || { error: { code: 4900, message: "KaChat Wallet did not answer." } }) }))
      .catch(() => toPage({ id: data.id, error: { code: 4900, message: "KaChat Wallet is unavailable. Reload this page." } }));
  });

  // Connecting, disconnecting or switching the connected account in the wallet.
  api.storage?.onChanged?.addListener((changes, area) => {
    const key = CONNECTION_KEYS.find((k) => changes[k]);
    if (area !== "local" || !key) return;
    const before = changes[key].oldValue?.[origin]?.address || null;
    const after = changes[key].newValue?.[origin]?.address || null;
    if (before === after) return;
    if (after) toPage({ event: "accountsChanged", payload: [after] });
    else {
      toPage({ event: "accountsChanged", payload: [] });
      toPage({ event: "disconnect", payload: null });
    }
  });
})();
