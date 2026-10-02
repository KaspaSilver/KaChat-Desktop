// Banners show whole (iOS c66bfc7, KNSBannerImageView fitsWidth): the full width at the picture's
// own proportions instead of a fixed height that crops it. Shapes outside 1.5:1 to 8:1 are held to
// those bounds and the picture is shown whole inside (contain), so a huge banner can never stretch
// the page. Until the picture loads - or when there is none - the element keeps its fixed height
// and gradient, as before.
const MIN_RATIO = 1.5;
const MAX_RATIO = 8;

function clampedRatio(width, height) {
  const ratio = width > 0 && height > 0 ? width / height : 3;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** A banner drawn as a CSS background on `el`: measures `url` and sizes `el` to it. "" resets. */
export function fitBackgroundBanner(el, url) {
  if (!el) return;
  const clean = String(url || "");
  el.dataset.bannerFitUrl = clean;
  if (!clean) {
    el.classList.remove("banner-fit");
    el.style.aspectRatio = "";
    return;
  }
  const probe = new Image();
  probe.referrerPolicy = "no-referrer";
  probe.onload = () => {
    if (el.dataset.bannerFitUrl !== clean) return; // a newer banner took its place
    el.style.aspectRatio = String(clampedRatio(probe.naturalWidth, probe.naturalHeight));
    el.classList.add("banner-fit");
  };
  probe.src = clean;
}

const IMG_SELECTOR = "img[data-banner-fit], img.chat-info-banner-img, img.kl-review-banner-img";

function fitImageBanner(img) {
  const box = img.parentElement;
  if (!box) return;
  box.style.aspectRatio = String(clampedRatio(img.naturalWidth, img.naturalHeight));
  box.classList.add("banner-fit");
  img.classList.add("banner-fit-img");
}

/** Banner <img>s (User Info, the .kachat editor's review card, anything marked data-banner-fit)
 *  size their box to the picture when they load. Installed once. */
export function installBannerImageFit() {
  if (installBannerImageFit.done || typeof document === "undefined") return;
  installBannerImageFit.done = true;
  document.addEventListener("load", (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.matches(IMG_SELECTOR)) fitImageBanner(img);
  }, true);
}
