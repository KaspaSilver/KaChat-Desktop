// On an https page, every plain-http subresource the page ever asks for (a link preview's og:image,
// an avatar a KNS profile points at, a leftover ws:// node) is upgraded to https/wss before it leaves
// the browser. One such request is enough for Chrome and Brave to mark the whole tab "Not secure"
// until the next navigation. Only on https: an http page on the LAN must keep talking plain http/ws
// to a local node.
//
// A classic (not module) script loaded from index.html's <head>, so it runs before anything else is
// requested. It used to be inline; it lives in a file so the Content-Security-Policy needs no
// 'unsafe-inline' for scripts (DSK-014). Served from public/, so the build copies it verbatim.
if (location.protocol === "https:") {
  var csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = "upgrade-insecure-requests";
  document.head.appendChild(csp);
}
