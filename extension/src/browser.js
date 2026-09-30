// One handle on the extension APIs for every browser we ship to. Chromium (Chrome, Brave, Edge,
// Opera, Arc) exposes `chrome` with promise-returning calls in Manifest V3; Firefox exposes
// `browser` and a `chrome` alias. `chrome` comes first: recent Chromium also defines a `browser`
// namespace whose runtime.onMessage drops sendResponse answers, which broke website requests.
export const ext = globalThis.chrome?.runtime ? globalThis.chrome : globalThis.browser;

/** True when running as an extension page or worker (not the plain desktop web app). */
export const isExtension = Boolean(ext?.runtime?.id);

/** chrome.storage.local: persists across browser restarts. The encrypted vault lives here. */
export const localArea = ext?.storage?.local;

/** chrome.storage.session: memory only, cleared when the browser closes, readable only by the
 *  extension's own pages and worker (never content scripts). The unlock key lives here. */
export const sessionArea = ext?.storage?.session;

export async function getLocal(key) {
  const result = await localArea.get(key);
  return result?.[key];
}

export async function setLocal(key, value) {
  await localArea.set({ [key]: value });
}

export async function removeLocal(keys) {
  await localArea.remove(keys);
}

export async function getSession(key) {
  if (!sessionArea) return undefined;
  const result = await sessionArea.get(key);
  return result?.[key];
}

export async function setSession(key, value) {
  if (!sessionArea) return;
  await sessionArea.set({ [key]: value });
}

export async function clearSession() {
  if (!sessionArea) return;
  await sessionArea.clear();
}

/** Fire-and-forget message to the background worker (it may be asleep; that is fine). */
export function tellBackground(message) {
  try {
    const sent = ext?.runtime?.sendMessage?.(message);
    sent?.catch?.(() => {});
  } catch { /* no background listening - nothing to do */ }
}
