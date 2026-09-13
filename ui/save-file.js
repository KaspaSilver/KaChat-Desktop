// Handing the reader a file. A desktop browser downloads it. A phone - above all a home-screen
// web app on iOS, where a download link has nowhere to go - gets the share sheet instead, which
// is how the iOS app exports too (Save to Files, AirDrop, Mail...). Falls back to the download
// link when sharing files is not available or the reader cancels into nothing.
function isTouch() {
  try { return window.matchMedia("(hover: none) and (pointer: coarse)").matches; } catch { return false; }
}

export async function saveFile(filename, type, content) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  if (isTouch() && typeof navigator.share === "function" && typeof File === "function") {
    try {
      const file = new File([blob], filename, { type: blob.type || type || "application/octet-stream" });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return true;
      }
    } catch (error) {
      // A cancelled share sheet is not a failure; anything else falls through to a download.
      if (error && error.name === "AbortError") return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}
