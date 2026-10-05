// The one shared .kachat names runtime (iOS KachatNamesService.shared / KachatNamesRegistry.shared /
// KachatNamesActions.shared): a single service, registry and actions instance for the whole app,
// so the Hub screens, name resolution, Your Domains and the profile hero all read the same registry
// and see the same registrations in flight.
//
// Two gates (iOS 7227d69, KachatNamesService.isEnabled / isLaunched):
//  - `kachatNamesUiEnabled()`: the .kachat UI and identity - true on every network. Mainnet shows
//    the same screens as testnet (empty, under "Coming soon") and people by assigned name, else
//    .kachat name, else short address - never by KNS.
//  - `kachatNamesLaunched()`: a live registry here - testnet-10 only for now (engine/network.js
//    IS_TESTNET). `kachatNames()` is the registry runtime and exists only then, so it is null on
//    mainnet and nothing there reads or writes a registry: refresh, owner tags, registration
//    resume and typed-name resolution all need it.
//  - `kachatProfilesEnabled()`: address profiles (iOS d36fc42) - every network. A profile is a
//    `kchat:1:profile:` self-send, not registry data, so `kachatProfiles()` exists on mainnet too:
//    the same `{ engine, service, registry, actions }` shape, where on mainnet the registry is inert
//    (isEnabled false: prepare/reads refuse, refreshes are no-ops) and only the profile side runs -
//    `registry.identity(address)` (profile-only: own saved record, else GET /profiles/{address} on
//    the chat indexer), `registry.ownProfile` / `noteOwnProfile`, `actions.profileSigner` /
//    `profileFee` / `saveProfile`. On testnet `kachatProfiles()` is the registry runtime itself.
import { IS_TESTNET } from "../engine/network.js";
import { getEndpoint } from "../engine/endpoints.js";
import { KachatNamesService } from "../engine/kachat-names/service.js";
import { KachatNamesRegistry } from "../engine/kachat-names/registry.js";
import { KachatNamesActions } from "../engine/kachat-names/actions.js";

let runtime = null;
/** the profile-only runtime where the registry isn't launched (mainnet) */
let profilesRuntime = null;

const localStorageAdapter = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage full: next refresh re-walks */ } },
};

/** Whether the .kachat UI and identity apply here: every network (iOS isEnabled, 7227d69). */
export function kachatNamesUiEnabled() { return KachatNamesService.isEnabled; }

/** Whether this network has a live .kachat registry (testnet-10 for now; iOS isLaunched). */
export function kachatNamesLaunched() { return IS_TESTNET && KachatNamesService.isLaunched; }

/** Whether address profiles (save your own, read others') work here: every network (iOS
 *  profilesEnabled, d36fc42). */
export function kachatProfilesEnabled() { return KachatNamesService.profilesEnabled; }

/**
 * Builds the runtime once the engine exists, where the registry is launched. Safe to call more
 * than once. `wallet` (optional): the wallet's other addresses for owner actions on names they hold
 * (iOS 881ada6) - `{ spendingAddresses() -> [{ index, address }], spendingPrivateKey(index) -> hex|null,
 * kasSignerAddresses() -> [{ account, index, address }] }`; see engine/kachat-names/actions.js.
 */
export function initKachatNamesRuntime(engine, { wallet = null } = {}) {
  if (!engine) return runtime;
  if (!kachatNamesLaunched()) {
    initProfilesOnly(engine);
    return runtime;
  }
  if (runtime) return runtime;
  const service = new KachatNamesService(engine);
  const registry = new KachatNamesRegistry({
    manifest: () => service.loadManifest(),
    isEnabled: () => KachatNamesService.isLaunched,
    getUtxosByAddresses: (addresses) => engine.utxosForRegistry(addresses),
    restBase: () => getEndpoint("kaspaApi"),
    indexerBase: () => getEndpoint("kasiaIndexer"),
    storage: localStorageAdapter,
  });
  const actions = new KachatNamesActions({ engine, service, registry, wallet });
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

/** Mainnet: the service, an inert registry (no manifest, isEnabled false - it never reads or writes
 *  registry data, only profiles) and the actions for the profile record. No name hooks: typed
 *  names don't resolve where there is no registry. */
function initProfilesOnly(engine) {
  if (profilesRuntime || !kachatProfilesEnabled()) return profilesRuntime;
  const service = new KachatNamesService(engine);
  const registry = new KachatNamesRegistry({
    manifest: null,
    isEnabled: () => false,
    getUtxosByAddresses: null,
    restBase: () => "",
    indexerBase: () => getEndpoint("kasiaIndexer"),
    storage: localStorageAdapter,
  });
  const actions = new KachatNamesActions({ engine, service, registry });
  profilesRuntime = { engine, service, registry, actions };
  return profilesRuntime;
}

/** The shared registry runtime, or null where the registry is not launched (mainnet) or before init. */
export function kachatNames() { return runtime; }

/** The runtime for address profiles on every network (`{ engine, service, registry, actions }`):
 *  the registry runtime where it is launched, else the profile-only one (inert registry). Null
 *  before init. Use only the profile side of it: registry.identity / ownProfile / noteOwnProfile /
 *  onChange / revision and actions.profileSigner / profileFee / saveProfile / myAddress. */
export function kachatProfiles() { return runtime ?? profilesRuntime; }
