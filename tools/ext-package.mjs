// Turns extension/dist (the Chromium build) into everything the stores take:
//
//   extension/dist-firefox/                 the same build with a Firefox manifest
//   extension/packages/kachat-wallet-<v>-chromium.zip   Chrome Web Store, Edge Add-ons, Opera
//   extension/packages/kachat-wallet-<v>-firefox.zip    addons.mozilla.org
//   extension/packages/kachat-wallet-<v>-source.zip     AMO wants the source of bundled code
//
//   npm run ext:package        (runs ext:build first)
//
// Firefox differences: MV3 background scripts instead of a service worker (Firefox runs
// background pages as event pages), a gecko id, and no minimum_chrome_version.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ext = `${root}extension`;
const dist = `${ext}/dist`;
const firefox = `${ext}/dist-firefox`;
const packages = `${ext}/packages`;

if (!existsSync(`${dist}/manifest.json`)) {
  console.error("extension/dist is missing - run npm run ext:build first.");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(`${dist}/manifest.json`, "utf8"));
const version = manifest.version;

rmSync(firefox, { recursive: true, force: true });
cpSync(dist, firefox, { recursive: true });
const ff = { ...manifest };
ff.background = { scripts: ["background.js"], type: "module" };
delete ff.minimum_chrome_version;
ff.browser_specific_settings = {
  gecko: {
    id: "wallet@kachat.app",
    strict_min_version: "128.0",
    // AMO's required data-collection declaration. The wallet sends public addresses to the Kaspa
    // network and APIs to show balances, and nothing to KaChat.
    data_collection_permissions: { required: ["none"] },
  },
};
writeFileSync(`${firefox}/manifest.json`, `${JSON.stringify(ff, null, 2)}\n`);

mkdirSync(packages, { recursive: true });
const zip = (from, name) => {
  const out = `${packages}/${name}`;
  rmSync(out, { force: true });
  execFileSync("zip", ["-qr", "-X", out, "."], { cwd: from });
  console.log("wrote", out.replace(root, ""));
};
zip(dist, `kachat-wallet-${version}-chromium.zip`);
zip(firefox, `kachat-wallet-${version}-firefox.zip`);
const source = `${packages}/kachat-wallet-${version}-source.zip`;
rmSync(source, { force: true });
execFileSync("git", ["archive", "--format=zip", "-o", source, "HEAD"], { cwd: root });
console.log("wrote", source.replace(root, ""));
