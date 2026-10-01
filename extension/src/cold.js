// Cold Storage - placeholder until the iOS port lands.
import { render } from "./ui.js";
import * as dock from "./dock.js";

export function showColdStorage() {
  render(`${dock.tabTopHtml("Cold Storage")}<section class="screen"><p class="muted">Coming next.</p></section>`, "cold:list");
  dock.bindTabTop();
}
