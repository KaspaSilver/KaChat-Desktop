// The one shared .kachat names runtime (iOS KachatNamesService.shared / KachatNamesRegistry.shared /
// KachatNamesActions.shared): a single service, registry and actions instance for the whole app,
// so the Hub screens, name resolution, Your Domains and the profile hero all read the same registry
// and see the same registrations in flight. Testnet-10 only (engine/network.js IS_TESTNET); on
// mainnet `kachatNames()` returns null and the screens keep their mockups.
import { IS_TESTNET } from "../engine/network.js";
import { getEndpoint } from "../engine/endpoints.js";
import { KachatNamesService } from "../engine/kachat-names/service.js";
import { KachatNamesRegistry } from "../engine/kachat-names/registry.js";
import { KachatNamesActions } from "../engine/kachat-names/actions.js";

let runtime = null;

const localStorageAdapter = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage full: next refresh re-walks */ } },
};

/** Builds the runtime once the engine exists. Safe to call more than once. */
export function initKachatNamesRuntime(engine) {
  if (runtime || !IS_TESTNET || !engine) return runtime;
  const service = new KachatNamesService(engine);
  const registry = new KachatNamesRegistry({
    manifest: () => service.loadManifest(),
    isEnabled: () => KachatNamesService.isEnabled,
    getUtxosByAddresses: (addresses) => engine.utxosForRegistry(addresses),
    restBase: () => getEndpoint("kaspaApi"),
    indexerBase: () => getEndpoint("kasiaIndexer"),
    storage: localStorageAdapter,
  });
  const actions = new KachatNamesActions({ engine, service, registry });
  // Name lookups and account discovery read the same registry (iOS 25cc2c9): a typed alice or
  // alice.kachat resolves to the owner of an ACTIVE name, refreshed when older than a minute.
  engine.setKachatNameHooks?.({
    resolve: async (canonical) => {
      await registry.refreshIfStale();
      return registry.resolveActive(canonical);
    },
    ownsAny: async (address) => {
      const key = KachatNamesRegistry.keyOf(address);
      if (!key) return false;
      await registry.refreshIfStale();
      return (await registry.namesOf(key, { includeInactive: true })).length > 0;
    },
  });
  runtime = { engine, service, registry, actions };
  return runtime;
}

/** The shared runtime, or null where .kachat is not live (mainnet) or before init. */
export function kachatNames() { return runtime; }

/** Whether .kachat names are live here (testnet-10). */
export function kachatNamesLive() { return IS_TESTNET; }
