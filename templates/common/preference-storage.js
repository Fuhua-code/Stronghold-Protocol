// Synchronous so preferences loaded during module evaluation see Android data immediately.
// Only sp.pref.* belongs here; session/identity tokens retain the upstream browser behavior.
export function createPreferenceStorage(env = globalThis) {
  const valid = (key) => typeof key === 'string' && key.startsWith('sp.pref.');
  const warn = (operation) => env.console?.warn?.(`[preferences] ${operation} failed; data was not persisted`);
  const native = () => {
    const b = env.SP_PREFERENCES;
    return b && typeof b.getPreference === 'function' && typeof b.setPreference === 'function'
      && typeof b.removePreference === 'function' ? b : null;
  };
  const browser = () => env.localStorage;
  return {
    getItem(key) {
      if (!valid(key)) throw new Error('unsupported preference key');
      try {
        const b = native();
        if (!b) return browser()?.getItem(key) ?? null;
        const raw = b.getPreference(key);
        // Native null is an intentional deletion; undefined/missing uses the envelope below.
        if (raw == null) return null; // Older native bridges are treated as absent for migration.
        const entry = JSON.parse(raw);
        if (entry.error) throw new Error('native storage unavailable');
        if (entry.found) return entry.value;
        const legacy = browser()?.getItem(key) ?? null;
        if (legacy !== null && !b.setPreference(key, legacy)) throw new Error('migration failed');
        return legacy;
      } catch { warn('read/migrate'); return null; }
    },
    setItem(key, value) {
      if (!valid(key) || typeof value !== 'string') throw new Error('invalid preference');
      try {
        const b = native();
        if (b) {
          if (!b.setPreference(key, value)) throw new Error('native write failed');
          // Best effort mirror for this origin. Native success is sufficient even at browser quota.
          try { browser()?.setItem(key, value); } catch { /* native is authoritative */ }
        } else {
          if (!browser()) throw new Error('browser storage unavailable');
          browser().setItem(key, value);
        }
      } catch (e) { warn('write'); throw e; }
    },
    removeItem(key) {
      if (!valid(key)) throw new Error('unsupported preference key');
      try {
        const b = native();
        if (b && !b.removePreference(key)) throw new Error('native delete failed');
        // Native retains a tombstone, preventing stale data on another origin from resurrecting.
        if (b) { try { browser()?.removeItem(key); } catch { /* tombstone is authoritative */ } }
        else {
          if (!browser()) throw new Error('browser storage unavailable');
          browser().removeItem(key);
        }
      } catch (e) { warn('delete'); throw e; }
    },
  };
}
export const preferenceStorage = createPreferenceStorage();
