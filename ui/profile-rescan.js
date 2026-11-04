// The hourly profile rescan's timing (iOS d1844582 ContactsManager.startProfileRescans), without a
// DOM, for tools/test-profile-rescan.mjs.

export const PROFILE_RESCAN_INTERVAL_MS = 3_600_000;
// Launch and coming back to the app have enough to do first.
export const PROFILE_RESCAN_FIRST_DELAY_MS = 30_000;
// One at a time, with room between them: this runs alongside everything else.
export const PROFILE_RESCAN_GAP_MS = 300;
// How often a long wait looks up again, so another account's turn isn't missed after a switch.
const WAIT_STEP_MS = 60_000;

/**
 * @param {object} options
 * @param {() => string} options.stampKey this wallet's stamp key, "" with no wallet
 * @param {(key: string) => number} options.readStamp
 * @param {(key: string, at: number) => void} options.writeStamp
 * @param {() => string[]} options.addresses
 * @param {(address: string) => Promise<unknown>} options.rescan
 */
export function createProfileRescans({
  stampKey, readStamp, writeStamp, addresses, rescan,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let current = null;

  async function run(token) {
    await sleep(PROFILE_RESCAN_FIRST_DELAY_MS);
    while (current === token) {
      const key = stampKey();
      const wait = key ? (Number(readStamp(key)) || 0) + PROFILE_RESCAN_INTERVAL_MS - now() : WAIT_STEP_MS;
      if (wait > 0) { await sleep(Math.min(wait, WAIT_STEP_MS)); continue; }
      // Stamped first, so one that's cut off waits for its turn rather than restarting at once.
      writeStamp(key, now());
      for (const address of new Set((addresses() || []).filter(Boolean))) {
        if (current !== token || stampKey() !== key) break;
        try { await rescan(address); } catch { /* the old profile stays; on to the next */ }
        await sleep(PROFILE_RESCAN_GAP_MS);
      }
    }
  }

  return {
    start() {
      if (current) return;
      current = {};
      run(current);
    },
    stop() { current = null; },
  };
}
