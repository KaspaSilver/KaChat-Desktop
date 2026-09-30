import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Builds the KaChat Wallet browser extension into extension/dist - a folder that loads as-is
// with "Load unpacked" in chrome://extensions (Chrome, Brave, Edge, Opera, Arc).
//
//   npm run ext:build      one build
//   npm run ext:watch      rebuild on every save (then press reload on the extension card)
//
// Shares ../engine and ../kaspa with the desktop app. public/ (manifest.json, icons) is copied
// verbatim to the root of dist.
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("."),
  base: "./",
  publicDir: here("public"),
  // Same reason as the desktop config: the Kaspa SDK's wasm-bindgen glue checks class NAMES,
  // and a minifier that renames classes breaks every object handed across (`new Resolver()`,
  // PrivateKey casts when signing).
  oxc: { keepNames: true },
  build: {
    outDir: here("dist"),
    emptyOutDir: true,
    target: "es2022",
    // Extension pages cannot run inline scripts (CSP), and Chromium 116+ has native modulepreload.
    modulePreload: { polyfill: false },
    // The Kaspa WASM is ~12 MB; this is expected, not a warning worth reading on every build.
    chunkSizeWarningLimit: 16_000,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        popup: here("popup.html"),
        background: here("src/background.js"),
      },
      output: {
        keepNames: true,
        // The manifest names the worker by path, so it keeps a fixed name.
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
