/**
 * Compile while the bytes are still arriving when the server labels them application/wasm
 * (the preview server and most proxies do) - on a 12MB module that overlaps the whole download
 * with the compile instead of doing one after the other. When the label is wrong, or the body
 * is encoded, compileStreaming refuses up front and the buffered path takes over from a clone.
 */
export async function compileWasmResponse(response) {
  const buffered = response.clone();
  if (typeof WebAssembly.compileStreaming === "function") {
    try {
      const module = await WebAssembly.compileStreaming(response);
      buffered.body?.cancel?.().catch?.(() => {});
      return module;
    } catch { /* wrong MIME type or encoding: buffer instead */ }
  }
  return buffered.arrayBuffer();
}

export async function loadKaspaModule() {
  const mod = await import("../kaspa/kaspa.js");
  // Resolve the .wasm relative to THIS module (not the document), so it's correct no matter what
  // path the app is served under.
  const wasmUrl = new URL("../kaspa/kaspa_bg.wasm", import.meta.url);
  // Fetch the bytes ourselves and hand them to wasm-bindgen as a BufferSource. This deliberately
  // avoids WebAssembly.instantiateStreaming, which HARD-FAILS when a reverse proxy (e.g. the
  // Nginx/DuckDNS front end for the test site) serves the .wasm with a Content-Type other than
  // application/wasm, or gzip-encodes it. Streaming works on localhost/Vite but breaks behind the
  // proxy — instantiating from an ArrayBuffer sidesteps both. wasm-bindgen deprecated positional
  // init params, so pass the single-object form.
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Could not fetch Kaspa WASM (HTTP ${response.status}) from ${wasmUrl.pathname}`);
  await mod.default({ module_or_path: await compileWasmResponse(response) });
  return mod;
  // The old kaspa-wasm.js/kaspa-wasm_bg.wasm "legacy fallback" was deleted: it was a
  // byte-identical copy of the files above (12.5 MB of duplicated repo weight), so the
  // fallback could only ever load the exact same bytes that just failed.
}
