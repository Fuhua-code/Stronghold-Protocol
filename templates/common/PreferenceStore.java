package io.prts.stronghold;

import android.util.AtomicFile;
import android.util.Log;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Port-independent preferences, outside nodejs-project (which is replaced on APK updates). */
public final class PreferenceStore {
    private final AtomicFile file;
    private JSONObject values;
    private boolean failed;
    private volatile boolean enabled;

    public PreferenceStore(File filesDir) {
        file = new AtomicFile(new File(filesDir, "preferences/local-preferences.json"));
        File parent = file.getBaseFile().getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) failed = true;
    }

    public void setEnabled(boolean value) { enabled = value; }

    private boolean allowed(String key) {
        return enabled && key != null && key.startsWith("sp.pref.") && key.length() <= 256;
    }

    private void load() throws Exception {
        if (failed) throw new Exception("storage unavailable");
        if (values != null) return;
        byte[] raw;
        try { raw = file.readFully(); }
        catch (java.io.FileNotFoundException missing) {
            if (file.getBaseFile().exists()) throw missing;
            values = new JSONObject(); return;
        }
        try {
            JSONObject parsed = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            java.util.Iterator<String> keys = parsed.keys();
            while (keys.hasNext()) {
                String key = keys.next(); Object value = parsed.get(key);
                if (!key.startsWith("sp.pref.") || !(value instanceof String || value == JSONObject.NULL))
                    throw new Exception("invalid preference envelope");
            }
            values = parsed;
        } catch (Exception damaged) {
            // Keep exact bytes before recovering; never overwrite an unreadable file without a backup.
            File backup = new File(file.getBaseFile().getParentFile(), "local-preferences.damaged-" + System.currentTimeMillis() + ".json");
            try (FileOutputStream out = new FileOutputStream(backup)) { out.write(raw); out.getFD().sync(); }
            catch (Exception backupError) { failed = true; throw backupError; }
            values = new JSONObject();
            Log.w("StrongholdProtocol", "Preference storage damaged; original backed up in app private storage");
        }
    }

    @JavascriptInterface
    public synchronized String getPreference(String key) {
        if (!allowed(key)) return "{\"error\":true}";
        try {
            load();
            Object value = values.opt(key);
            return new JSONObject().put("found", values.has(key)).put("value", value == JSONObject.NULL ? null : value).toString();
        } catch (Exception e) {
            failed = true;
            Log.w("StrongholdProtocol", "Preference storage read failed");
            return "{\"error\":true}";
        }
    }

    private boolean put(String key, Object value) {
        if (!allowed(key)) return false;
        FileOutputStream stream = null;
        try {
            load();
            JSONObject next = new JSONObject(values.toString());
            next.put(key, value);
            byte[] bytes = next.toString().getBytes(StandardCharsets.UTF_8);
            stream = file.startWrite();
            stream.write(bytes);
            stream.getFD().sync();
            file.finishWrite(stream);
            stream = null;
            values = next; // Commit memory only after disk succeeds.
            return true;
        } catch (Exception e) {
            if (stream != null) file.failWrite(stream);
            Log.w("StrongholdProtocol", "Preference storage write failed");
            return false;
        }
    }

    @JavascriptInterface
    public synchronized boolean setPreference(String key, String value) {
        return value != null && value.length() <= 8_000_000 && put(key, value);
    }

    @JavascriptInterface
    public synchronized boolean removePreference(String key) {
        return put(key, JSONObject.NULL); // Tombstone also suppresses legacy migration on other ports.
    }
}
