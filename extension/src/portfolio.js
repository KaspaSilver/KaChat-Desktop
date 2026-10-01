// Portfolio - placeholder until the iOS port lands.
import { render } from "./ui.js";
import * as dock from "./dock.js";

export function showPortfolio() {
  render(`${dock.tabTopHtml("Portfolio")}<section class="screen"><p class="muted">Coming next.</p></section>`, "portfolio:home");
  dock.bindTabTop();
}

/**
 * iOS AddToPortfolioSheet, opened from a transaction's actions sheet.
 * @param {{txid:string, direction:"in"|"out", amountSompi:bigint, time:number, sourceAddress:string, onDone:Function}} opts
 */
export function showAddToPortfolio(opts) {
  opts.onDone?.();
}
