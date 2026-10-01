// Camera QR scanning - iOS QRScannerView (one text code: a kpub, a recipient) and
// MultiFrameQRScannerView (KasSigner's binary multi-frame signed transaction), over
// getUserMedia + jsQR. jsQR's binaryData keeps every byte; BarcodeDetector only returns text,
// which corrupts binary frames, so it is not used.
//
// A toolbar popup can't show the browser's camera permission prompt (the request just fails).
// When that happens the scanner offers to open KaChat Wallet in a tab, where the prompt works;
// the browser then remembers the answer for the extension, and the popup can scan from then on.

import jsQR from "jsqr";
import { ext } from "./browser.js";
import { esc, isTab } from "./ui.js";

const CLOSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/**
 * Opens the scanner over the current screen.
 *   scanQr({ title, hint })                                   -> Promise<string | null>
 *   scanQr({ title, hint, onBinaryFrame: (bytes) => result })  -> Promise<Uint8Array | null>
 * For binary scans, onBinaryFrame gets each frame's bytes and returns
 * { complete: Uint8Array | null, progress: { received, total, indices } | null } - e.g. a
 * QrFrameAccumulator from ui/kspt.js. Resolves null when cancelled.
 */
export function scanQr({ title = "Scan QR Code", hint = "Point camera at a QR code", onBinaryFrame = null } = {}) {
  return new Promise((resolve) => {
    document.querySelector(".scanner")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "scanner";
    overlay.innerHTML = `
      <header class="scanner-bar">
        <button class="bar-text" data-cancel>Cancel</button>
        <div class="nav-title">${esc(title)}</div>
        <span></span>
      </header>
      <div class="scanner-stage">
        <video playsinline muted></video>
        <div class="scanner-frame"></div>
        <div class="scanner-hint">Requesting camera access...</div>
        <div class="scanner-progress" hidden></div>
      </div>`;
    document.body.appendChild(overlay);
    const video = overlay.querySelector("video");
    const hintEl = overlay.querySelector(".scanner-hint");
    const progressEl = overlay.querySelector(".scanner-progress");
    let stream = null;
    let running = true;
    let lastDecode = 0;

    const finish = (value) => {
      running = false;
      if (stream) for (const track of stream.getTracks()) track.stop();
      overlay.remove();
      document.removeEventListener("visibilitychange", onHidden);
      resolve(value);
    };
    const onHidden = () => { if (document.hidden) finish(null); };
    document.addEventListener("visibilitychange", onHidden);
    overlay.querySelector("[data-cancel]").onclick = () => finish(null);

    const denied = (inPopup) => {
      overlay.querySelector(".scanner-stage").innerHTML = `
        <div class="scanner-denied">
          <div class="strong">Camera Access Required</div>
          <p class="muted small">${inPopup
            ? "The toolbar window can't ask for the camera. Open KaChat Wallet in a tab once and allow the camera there - after that, scanning works here too."
            : "Allow the camera for KaChat Wallet in your browser's site settings, then try again."}</p>
          ${inPopup ? '<button id="camera-tab">Allow Camera in a Tab</button>' : ""}
        </div>`;
      const button = overlay.querySelector("#camera-tab");
      if (button) button.onclick = async () => {
        await ext.tabs.create({ url: ext.runtime.getURL("popup.html?view=camera") });
        finish(null);
      };
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch {
        if (running) denied(!isTab);
        return;
      }
      if (!running) { for (const track of stream.getTracks()) track.stop(); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      hintEl.textContent = hint;
      const grab = document.createElement("canvas");
      const ctx = grab.getContext("2d", { willReadFrequently: true });
      const tick = (now) => {
        if (!running) return;
        // iOS throttles decoding to one try per 0.15 s.
        if (now - lastDecode >= 150 && video.readyState >= 2 && video.videoWidth) {
          lastDecode = now;
          grab.width = video.videoWidth;
          grab.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const image = ctx.getImageData(0, 0, grab.width, grab.height);
          const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
          if (code) {
            if (!onBinaryFrame) {
              if (code.data) return finish(code.data);
            } else if (code.binaryData?.length) {
              const result = onBinaryFrame(new Uint8Array(code.binaryData)) || {};
              if (result.progress) {
                const { received, total, indices = [] } = result.progress;
                hintEl.hidden = true;
                progressEl.hidden = false;
                progressEl.innerHTML = `
                  <div class="scanner-dots">${Array.from({ length: total }, (_, i) => `<span class="${indices.includes(i) ? "on" : ""}"></span>`).join("")}</div>
                  <div class="small">${received} / ${total} frames</div>`;
              }
              if (result.complete) return finish(result.complete);
            }
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();
  });
}

/** popup.html?view=camera - the one-time permission page the scanner opens from the popup. */
export async function showCameraPermissionPage(app) {
  app.innerHTML = `
    <section class="screen center camera-permission">
      <h2 class="center-text">Camera for KaChat Wallet</h2>
      <p class="muted center-text" id="camera-status">Allow the camera when your browser asks.</p>
    </section>`;
  const status = app.querySelector("#camera-status");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    for (const track of stream.getTracks()) track.stop();
    status.textContent = "Camera allowed. Close this tab and scan again in KaChat Wallet.";
  } catch {
    status.textContent = "The camera wasn't allowed. Allow it for this extension in your browser's site settings, then reload this tab.";
  }
}
