// KaChat Wallet's website provider: window.kachat, injected into the page's own JavaScript world.
//
// Websites talk to the wallet only through these calls; each one travels page -> content
// script -> extension background, and anything that reveals an address, moves Kaspa or signs
// opens a KaChat approval window first. Method names follow KasWare's where they overlap, so a
// Kaspa site can support both with little code.
//
//   await kachat.requestAccounts()            -> ["kaspa:..."]   (asks the user to connect)
//   await kachat.getAccounts()                -> [] until connected and unlocked
//   await kachat.getNetwork()                 -> "mainnet" | "testnet-10"
//   await kachat.getPublicKey()               -> "02..."
//   await kachat.getBalance()                 -> { confirmed, unconfirmed, total }  (sompi)
//   await kachat.sendKaspa(to, sompi, { priorityFee })  -> txid   (asks the user)
//   await kachat.signMessage(text)            -> signature hex    (asks the user)
//   await kachat.disconnect()
//   kachat.on("accountsChanged" | "disconnect", handler) / kachat.removeListener(...)
(() => {
  if (window.kachat) return;
  const CHANNEL = "kachat-wallet";
  const pending = new Map();
  const listeners = { accountsChanged: new Set(), disconnect: new Set() };
  let nextId = 1;

  class KaChatWalletError extends Error {
    constructor(message, code) {
      super(message);
      this.name = "KaChatWalletError";
      this.code = code;
    }
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.channel !== CHANNEL || data.direction !== "to-page") return;
    if (data.event) {
      for (const handler of listeners[data.event] || []) {
        try { handler(data.payload); } catch (error) { console.error(error); }
      }
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new KaChatWalletError(data.error.message || "Request failed.", data.error.code));
    else entry.resolve(data.result);
  });

  const call = (method, params = []) => new Promise((resolve, reject) => {
    const id = `${Date.now()}-${nextId++}`;
    pending.set(id, { resolve, reject });
    window.postMessage({ channel: CHANNEL, direction: "to-content", id, method, params }, window.location.origin);
  });

  const provider = Object.freeze({
    isKaChat: true,
    version: "1",
    requestAccounts: () => call("requestAccounts"),
    getAccounts: () => call("getAccounts"),
    getNetwork: () => call("getNetwork"),
    getPublicKey: () => call("getPublicKey"),
    getBalance: () => call("getBalance"),
    sendKaspa: (toAddress, sompi, options = {}) => call("sendKaspa", [String(toAddress), String(sompi), { priorityFee: options?.priorityFee != null ? String(options.priorityFee) : "0" }]),
    signMessage: (message) => call("signMessage", [String(message)]),
    disconnect: () => call("disconnect"),
    on(event, handler) { if (listeners[event] && typeof handler === "function") listeners[event].add(handler); return provider; },
    removeListener(event, handler) { listeners[event]?.delete(handler); return provider; },
  });

  Object.defineProperty(window, "kachat", { value: provider, writable: false, configurable: false, enumerable: true });
  window.dispatchEvent(new Event("kachat#initialized"));
})();
