// The bots' move search, off the main thread (iOS runs it in a detached Task): ui/chess-bots.js
// posts { id, board, settings, avoiding } and gets back { id, move } (move null when there is
// none) or { id, error }. Started with `new Worker(new URL(...), { type: "module" })`, which Vite
// bundles as its own same-origin asset (CSP worker-src 'self').

import { chessBotBestMove } from "./chess-bot.js";

self.onmessage = (event) => {
  const { id, board, settings, avoiding } = event.data || {};
  try {
    const move = chessBotBestMove(board, settings, avoiding || []);
    self.postMessage({ id, move });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
