/* Classic boot script, loaded before the game modules. It adapts the browser storage the
 * upstream client already uses to the Android-native stores, so the game source needs no
 * persistence rewrite:
 *   - sp.pref.stats        -> SP_BRIDGE StatsStore (authoritative), mirrored to preferences/localStorage
 *   - other sp.pref.*      -> SP_PREFERENCES PreferenceStore, mirrored to localStorage
 *   - stronghold-stats-*.json export blobs -> SP_BRIDGE.exportStats (native MediaStore/SAF dialog)
 * Desktop browsers without the bridges keep the original localStorage behaviour.
 */
(function () {
  'use strict';
  var w = window;
  if (w.__spExtensionBoot) return;
  w.__spExtensionBoot = 1;

  var StorageProto = w.Storage && w.Storage.prototype;
  if (!StorageProto || typeof StorageProto.getItem !== 'function') return;
  var originalGet = StorageProto.getItem;
  var originalSet = StorageProto.setItem;
  var originalRemove = StorageProto.removeItem;
  var STATS_KEY = 'sp.pref.stats';
  var PREF_PREFIX = 'sp.pref.';

  function isLocalStorage(self) {
    try { return self === w.localStorage; } catch (e) { return false; }
  }
  function isPrefKey(key) {
    return typeof key === 'string' && key.indexOf(PREF_PREFIX) === 0 && key.length <= 256;
  }
  function preferences() {
    var b = w.SP_PREFERENCES;
    return b && typeof b.getPreference === 'function' && typeof b.setPreference === 'function'
      && typeof b.removePreference === 'function' ? b : null;
  }
  function statsBridge() {
    var b = w.SP_BRIDGE;
    return b && typeof b.readLocalStats === 'function' && typeof b.writeLocalStats === 'function'
      && typeof b.removeLocalStats === 'function' ? b : null;
  }
  function nativePreference(key) {
    var b = preferences();
    if (!b) return { found: false, value: null, absent: true };
    try {
      var raw = b.getPreference(key);
      if (raw == null) return { found: false, value: null, absent: true };
      var entry = JSON.parse(raw);
      if (entry.error) return { error: true };
      return { found: entry.found === true, value: entry.value === undefined ? null : entry.value };
    } catch (e) { return { error: true }; }
  }
  function readPreference(key) {
    var native = nativePreference(key);
    if (!native.absent && !native.error && native.found) return native.value;
    // migrate a browser-era value into the native store on first read
    var legacy = null;
    try { legacy = originalGet.call(w.localStorage, key); } catch (e) { legacy = null; }
    if (legacy !== null && !native.error) {
      var b = preferences();
      if (b) { try { b.setPreference(key, legacy); } catch (e) { /* native is unavailable */ } }
    }
    return legacy;
  }
  function writePreference(key, value) {
    var b = preferences();
    if (b) {
      if (!b.setPreference(key, value)) throw new Error('native preference write failed');
      try { originalSet.call(w.localStorage, key, value); } catch (e) { /* native is authoritative */ }
      return;
    }
    originalSet.call(w.localStorage, key, value);
  }
  function removePreference(key) {
    var b = preferences();
    if (b) {
      if (!b.removePreference(key)) throw new Error('native preference remove failed');
      try { originalRemove.call(w.localStorage, key); } catch (e) { /* tombstone is authoritative */ }
      return;
    }
    originalRemove.call(w.localStorage, key);
  }
  function readStats() {
    var b = statsBridge();
    if (b) {
      try {
        var stored = b.readLocalStats();
        if (stored != null) return stored;
      } catch (e) { /* fall through to the legacy mirror */ }
    }
    var legacy = readPreference(STATS_KEY);
    if (legacy !== null && b) { try { b.writeLocalStats(legacy); } catch (e) { /* seed best effort */ } }
    return legacy;
  }
  function writeStats(value) {
    var b = statsBridge();
    if (b) {
      if (!b.writeLocalStats(value)) throw new Error('native stats write failed');
      try { writePreference(STATS_KEY, value); } catch (e) { /* the device store is authoritative */ }
      return;
    }
    writePreference(STATS_KEY, value);
  }
  function removeStats() {
    var b = statsBridge();
    if (b) {
      try { b.removeLocalStats(); } catch (e) { /* remove the mirror below anyway */ }
      try { removePreference(STATS_KEY); } catch (e) { /* tombstone best effort */ }
      return;
    }
    removePreference(STATS_KEY);
  }

  StorageProto.getItem = function (key) {
    if (!isLocalStorage(this)) return originalGet.call(this, key);
    try {
      if (key === STATS_KEY) return readStats();
      if (isPrefKey(key)) return readPreference(key);
    } catch (e) { /* native unavailable: keep the page usable */ }
    return originalGet.call(this, key);
  };
  StorageProto.setItem = function (key, value) {
    if (!isLocalStorage(this)) return originalSet.call(this, key, value);
    if (key === STATS_KEY) { writeStats(String(value)); return; }
    if (isPrefKey(key)) { writePreference(key, String(value)); return; }
    return originalSet.call(this, key, value);
  };
  StorageProto.removeItem = function (key) {
    if (!isLocalStorage(this)) return originalRemove.call(this, key);
    if (key === STATS_KEY) { removeStats(); return; }
    if (isPrefKey(key)) { removePreference(key); return; }
    return originalRemove.call(this, key);
  };

  // Stats export: the upstream page builds a JSON Blob and clicks an <a download>. Blob URLs
  // never reach WebView's DownloadListener, so hand the text to the native exporter instead.
  var blobUrls = new Map();
  var createObjectURL = w.URL && w.URL.createObjectURL;
  var revokeObjectURL = w.URL && w.URL.revokeObjectURL;
  if (typeof createObjectURL === 'function') {
    w.URL.createObjectURL = function (blob) {
      var url = createObjectURL.call(w.URL, blob);
      try { if (blob instanceof w.Blob && String(blob.type || '').indexOf('json') >= 0) blobUrls.set(url, blob); } catch (e) { /* not a Blob */ }
      return url;
    };
  }
  if (typeof revokeObjectURL === 'function') {
    w.URL.revokeObjectURL = function (url) {
      blobUrls.delete(url);
      return revokeObjectURL.call(w.URL, url);
    };
  }
  var anchorProto = w.HTMLAnchorElement && w.HTMLAnchorElement.prototype;
  var anchorClick = anchorProto && anchorProto.click;
  if (anchorProto && typeof anchorClick === 'function') {
    anchorProto.click = function () {
      var href = this.href;
      var name = this.download || '';
      var blob = blobUrls.get(href);
      if (!blob || !/^stronghold-stats-.*\.json$/i.test(name)) return anchorClick.call(this);
      var bridge = statsBridge();
      var exportFn = w.SP_BRIDGE && w.SP_BRIDGE.exportStats;
      if (!bridge || typeof exportFn !== 'function' || typeof blob.text !== 'function') return anchorClick.call(this);
      blobUrls.delete(href);
      blob.text().then(function (text) {
        try { exportFn.call(w.SP_BRIDGE, name, text); }
        catch (e) { console.warn('[sp-boot] native stats export failed', e); anchorClick.call(this); }
      }.bind(this), function () { anchorClick.call(this); }.bind(this));
    };
  }

  try {
    console.info('[sp-boot] Android storage bridge ' + (statsBridge() ? 'stats ' : '') + (preferences() ? 'prefs' : ''));
  } catch (e) { /* logging is best effort */ }
})();
