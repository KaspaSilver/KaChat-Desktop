// Which accounts on this device still owe the backup steps (iOS d063b897 / KaPay 99ab88a
// AccountBackupStatus). An account created here starts with it owed, since nobody has seen its seed
// phrase yet; an imported one never does, since whoever imported it has its seed. Accounts from
// before this existed have no entry at all, so they are never owed one and have no Backup Hygiene
// timer. Kept for an account's addresses on both networks, so a switch to testnet doesn't lose or
// bring back the card.
//
// Finishing the backup steps or importing the account also starts a timer (iOS 836b62bc): six months
// later the Backup Hygiene card asks for a few of the words again, and passing that or redoing the
// backup starts it over.
//
// Only addresses and times live here, never a word of the seed phrase. The logic the backup steps
// run on (ui/account-backup.js) is here too, without a DOM, for tools/test-account-backup.mjs.

export const BACKUP_PENDING_KEY = "kachat-backup-pending-addresses-v1";
export const BACKUP_CONFIRMED_KEY = "kachat-backup-confirmed-at-v1";
export const HYGIENE_MONTHS = 6;

/** The backup steps show the words a few at a time and then ask for some back (iOS AccountBackupView). */
export const WORDS_PER_PAGE = 6;
export const BACKUP_WORDS_TO_CHECK = 4;
/** Backup Hygiene asks for more of them (iOS BackupHygieneView). */
export const HYGIENE_WORDS_TO_CHECK = 5;

/** `date` plus whole calendar months, on the same day or the month's last (iOS Calendar .month:
 *  31 August plus six months is the last of February). */
export function addCalendarMonths(date, months) {
  const out = new Date(date);
  const day = out.getDate();
  out.setDate(1);
  out.setMonth(out.getMonth() + months);
  const lastDay = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, lastDay));
  return out;
}

/**
 * @param {{ storage: Pick<Storage, "getItem" | "setItem">, variants?: (address: string) => string[] }} options
 *   `variants`: an account's address on every network (the address itself included).
 */
export function createAccountBackupStatus({ storage, variants = (address) => [address] }) {
  const addressesOf = (address) => {
    const clean = String(address || "").trim();
    if (!clean) return [];
    return [...new Set([clean, ...(variants(clean) || [])].filter(Boolean))];
  };
  const readPending = () => {
    try {
      const list = JSON.parse(storage.getItem(BACKUP_PENDING_KEY) || "[]");
      return new Set(Array.isArray(list) ? list.filter((entry) => typeof entry === "string") : []);
    } catch { return new Set(); }
  };
  const writePending = (set) => { try { storage.setItem(BACKUP_PENDING_KEY, JSON.stringify([...set])); } catch { /* storage full: owed again or not on the next write */ } };
  /** Address -> when its backup was last finished or checked, in seconds since 1970. */
  const readConfirmed = () => {
    try {
      const map = JSON.parse(storage.getItem(BACKUP_CONFIRMED_KEY) || "{}");
      return map && typeof map === "object" && !Array.isArray(map) ? map : {};
    } catch { return {}; }
  };
  const writeConfirmed = (map) => { try { storage.setItem(BACKUP_CONFIRMED_KEY, JSON.stringify(map)); } catch { /* storage full */ } };

  const status = {
    isPending(address) {
      const clean = String(address || "").trim();
      return Boolean(clean) && readPending().has(clean);
    },
    markPending(address) {
      const pending = readPending();
      for (const entry of addressesOf(address)) pending.add(entry);
      writePending(pending);
    },
    markDone(address) {
      const pending = readPending();
      for (const entry of addressesOf(address)) pending.delete(entry);
      writePending(pending);
    },
    /** Six months since this account was imported, or its backup last finished or checked. */
    isHygieneDue(address, now = new Date()) {
      const clean = String(address || "").trim();
      if (!clean || status.isPending(clean)) return false;
      const stamp = Number(readConfirmed()[clean]);
      if (!Number.isFinite(stamp) || stamp <= 0) return false;
      return now >= addCalendarMonths(new Date(stamp * 1000), HYGIENE_MONTHS);
    },
    /** The account was imported, the backup steps finished or the words checked: nothing is owed,
     *  and the six months start over. */
    markConfirmed(address, now = new Date()) {
      status.markDone(address);
      const confirmed = readConfirmed();
      for (const entry of addressesOf(address)) confirmed[entry] = now.getTime() / 1000;
      writeConfirmed(confirmed);
    },
    /** The account is gone from this device. */
    forget(address) {
      status.markDone(address);
      const confirmed = readConfirmed();
      for (const entry of addressesOf(address)) delete confirmed[entry];
      writeConfirmed(confirmed);
    },
    /** The account moved to another chatting address (the same seed): what it owes moves with it. */
    carry(fromAddress, toAddress) {
      const pending = status.isPending(fromAddress);
      const stamp = Number(readConfirmed()[String(fromAddress || "").trim()]);
      status.forget(fromAddress);
      if (pending) status.markPending(toAddress);
      if (Number.isFinite(stamp) && stamp > 0) {
        const confirmed = readConfirmed();
        for (const entry of addressesOf(toAddress)) confirmed[entry] = stamp;
        writeConfirmed(confirmed);
      }
    },
  };
  return status;
}

/** The name a new account gets, renameable later: "My Account", then "My Account 2" and on,
 *  skipping any name a saved account already has (iOS WalletManager.nextDefaultAccountName). */
export function nextDefaultAccountName(takenNames = [], base = "My Account") {
  const taken = new Set([...takenNames].map((name) => String(name ?? "").trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let number = 2;
  while (taken.has(`${base} ${number}`.toLowerCase())) number += 1;
  return `${base} ${number}`;
}

/** Whether these amounts hold anything. Both in sompi, null while unknown. The backup banner passes
 *  the chatting balance alone (iOS bfe9f022 AccountBackupBanner.hasFunds). */
export function accountHasFunds(chattingSompi, spendingTotalSompi) {
  return (BigInt(chattingSompi ?? 0n) + BigInt(spendingTotalSompi ?? 0n)) > 0n;
}

/** This account's steps: the passphrase's only when it has one. */
export function backupStepsFor(hasPassphrase) {
  return hasPassphrase
    ? ["why", "prepare", "words", "wordCheck", "passphrase", "passphraseCheck", "tips"]
    : ["why", "prepare", "words", "wordCheck", "tips"];
}

export function wordPageCount(wordCount) {
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_PAGE));
}

/** The positions (0-based, end exclusive) one page of the words shows. */
export function wordPageRange(page, wordCount) {
  const start = page * WORDS_PER_PAGE;
  return [start, Math.min(start + WORDS_PER_PAGE, wordCount)];
}

function cryptoRandomBelow(limit) {
  // Rejection sampling: no position is likelier than another.
  const ceiling = Math.floor(0x100000000 / limit) * limit;
  const buffer = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(buffer); } while (buffer[0] >= ceiling);
  return buffer[0] % limit;
}

/** `take` different positions out of `count`, in random order. */
export function randomWordPositions(count, take, randomBelow = cryptoRandomBelow) {
  const positions = Array.from({ length: count }, (_, index) => index);
  for (let index = positions.length - 1; index > 0; index -= 1) {
    const other = randomBelow(index + 1);
    [positions[index], positions[other]] = [positions[other], positions[index]];
  }
  return positions.slice(0, take);
}

/** The backup steps ask in phrase order; Backup Hygiene keeps the random order. */
export function backupCheckPositions(count, randomBelow = cryptoRandomBelow) {
  return randomWordPositions(count, BACKUP_WORDS_TO_CHECK, randomBelow).sort((a, b) => a - b);
}

export function normalizedWord(word) {
  return String(word ?? "").trim().toLowerCase();
}

/** Which of the asked positions don't match. `answers`: position -> what was typed. */
export function wrongWordPositions(words, positions, answers) {
  return positions.filter((position) => normalizedWord(answers[position]) !== words[position]);
}

/** A passphrase has to match exactly, capitals and spaces included. A saved "nfkd" one is stored
 *  NFKD (audit EXT-010), so what was typed is compared in that form: an accented letter typed as one
 *  character is the same passphrase. A "raw" one (pre-EXT-010) is compared as it stands. */
export function passphraseMatches(typed, stored, passphraseForm = "nfkd") {
  const answer = String(typed ?? "");
  return (passphraseForm === "raw" ? answer : answer.normalize("NFKD")) === String(stored ?? "");
}
