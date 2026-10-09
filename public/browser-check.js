// Old-browser check: runs before the app, written in old JavaScript (no let/const/arrow functions)
// so even iOS 10 Safari can run it. KaChat Desktop needs WebAssembly (the Kaspa signing engine)
// and modern JavaScript (ES modules, top-level await, BigInt). A browser without them never starts
// the app and was left showing the bare chats layout (seen on an iPhone 5, iOS 10). Here it gets a
// clear message instead. Supported browsers are untouched.
(function () {
  var ok = true;
  try {
    ok = typeof WebAssembly === "object" &&
      typeof BigInt === "function" &&
      "noModule" in document.createElement("script") &&
      typeof Array.prototype.at === "function" &&
      !!(window.crypto && window.crypto.subtle);
  } catch (e) {
    ok = false;
  }
  if (ok) return;

  function show() {
    var body = document.body;
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    body.setAttribute("style", "margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1412;color:#e8f0ed;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;");
    var box = document.createElement("div");
    box.setAttribute("style", "max-width:420px;padding:32px 24px;text-align:center;");
    var title = document.createElement("h1");
    title.setAttribute("style", "font-size:24px;margin:0 0 12px;");
    title.appendChild(document.createTextNode("This browser is too old for KaChat"));
    var text = document.createElement("p");
    text.setAttribute("style", "font-size:16px;line-height:1.5;margin:0 0 12px;color:#b9c7c2;");
    text.appendChild(document.createTextNode("KaChat Desktop needs a newer browser. Please open it in Safari on iOS 15 or later, or in a current version of Chrome, Firefox or Edge."));
    var note = document.createElement("p");
    note.setAttribute("style", "font-size:14px;line-height:1.5;margin:0;color:#8ea39c;");
    note.appendChild(document.createTextNode("Nothing was saved on this device."));
    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(note);
    body.appendChild(box);
    try { document.title = "KaChat: browser not supported"; } catch (e) { /* ignore */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", show);
  } else {
    show();
  }
})();
