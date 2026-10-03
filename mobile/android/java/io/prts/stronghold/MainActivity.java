// mobile/android/java/io/prts/stronghold/MainActivity.java — the Android shell of 卫戍协议：盟约.
//
// It runs the *unmodified* game server inside the app and shows the *unmodified* web client in a WebView:
//
//   1. the APK's `assets/nodejs-project/` (server + shared + data + the client's public/, plus mobile/node/main.js)
//      is unpacked into the app's private files directory on first start and after every app update;
//   2. the **Node runtime itself lives in `lib/<abi>/`**, which Android extracts into the app's native library
//      directory (`ApplicationInfo.nativeLibraryDir`) — the one place an app is allowed to execute a program from
//      and where the dynamic linker resolves its dependencies without a W^X violation. The APK carries one runtime
//      per ABI (arm64-v8a for phones, x86_64 for the usual Android emulators) and Android unpacks only the one it
//      needs; {@link #runtimeDir()} finds it. That runtime is Termux's Node 24 LTS build (`node` plus libc++,
//      openssl, c-ares, libicu, libsqlite and zlib);
//   3. Node is started as
//        node <filesDir>/nodejs-project/mobile/node/main.js
//             --public <filesDir>/nodejs-project/public --data <filesDir>/nodejs-project/data
//             --handshake <filesDir>/handshake.json
//      either directly (most ROMs allow exec from the app's data directory) or, when that fails, through
//      `/system/bin/linker64 <node> …`, which loads the executable as a shared object and sidesteps the Android 10+
//      exec restriction (`execve` returns EACCES for files in the app's private storage);
//   4. a watcher thread waits for handshake.json (written by main.js after the server answered /healthz and a
//      WebSocket upgrade) and then loads http://127.0.0.1:<port>/ — one origin, so WebSocket, audio, touch and the
//      safe-area insets behave exactly like in a browser tab;
//   5. the same server is reachable from the local network (it binds 0.0.0.0), so friends can join with the
//      `?room=KEY` link the game itself shows.

package io.prts.stronghold;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class MainActivity extends Activity {
    private static final String TAG = "StrongholdProtocol";
    private static final String PREFS = "sp_android";
    private static final String K_LAST_UPDATE = "lastUpdateTime";
    private static final String K_VERSION = "versionName";
    /** How long the server may take to write its handshake before we give up (a slow phone needs a few seconds). */
    private static final int START_TIMEOUT_MS = 180000;
    /** Background colour of the loading screen (#0c0f0e, the client's own dark background). */
    private static final int BG = Color.rgb(0x0C, 0x0F, 0x0E);
    private static final int FG = Color.rgb(0xD8, 0xE3, 0xDE);
    private static final int ACCENT = Color.rgb(0x4E, 0xD8, 0xAF);
    /** The unpacked game (server code, data and the client) inside the app's private storage. */
    private static final String PROJECT = "nodejs-project";

    /** Guards against a second Activity instance trying to start a second server. */
    private static boolean sServerStarted = false;
    /** `local` = play with this phone's server; `remote` = the app was opened to join another host. */
    private static final String MODE_LOCAL = "local";
    private static final String MODE_REMOTE = "remote";
    private static String sMode = MODE_LOCAL;
    /** The remote link the app was opened with (extends strings from other apps), or null. */
    private static String sRemoteUrl = null;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    /** The WebView showing a remote game, once the player leaves the local server. */
    private WebView remoteWeb;
    private LinearLayout overlay;
    private TextView status;
    private TextView detail;
    private Button actionButton;
    private JSONObject handshake;
    private Process nodeProcess;
    /** True once the local Node server was asked to stop (remote play). */
    private volatile boolean serverStopped = false;

    // -----------------------------------------------------------------------------------------------
    // activity lifecycle
    // -----------------------------------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // A link handed to the app (`--connect <url>`, or an ACTION_VIEW intent from another app) means the player
        // wants to join another host: the local server still starts, but only to serve the connect shell that
        // verified and opened the link — and it stops again as soon as the remote page is up.
        parseInvocation(getIntent());
        Log.i(TAG, "onCreate: sdk=" + Build.VERSION.SDK_INT + " abi=" + Build.SUPPORTED_ABIS[0]
                + " started=" + sServerStarted + " mode=" + sMode + (sRemoteUrl == null ? "" : " url=" + sRemoteUrl));
        buildUi();
        if (savedInstanceState != null && savedInstanceState.containsKey("url")) {
            loadUrl(savedInstanceState.getString("url"));
            return;
        }
        startEverything();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask: a second link arrives here instead of a new activity
        parseInvocation(intent);
        if (sRemoteUrl != null) showRemote(sRemoteUrl);
    }

    /** `--connect <url>` (the packager's own flag) or an `ACTION_VIEW` http(s) link both mean remote mode. */
    private static void parseInvocation(Intent intent) {
        if (intent == null) return;
        String url = intent.getStringExtra("connect");
        if (url == null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getDataString() != null) {
            url = intent.getDataString();
        }
        if (url == null || url.length() == 0) return;
        sRemoteUrl = url;
        sMode = MODE_REMOTE;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null && web.getUrl() != null) out.putString("url", web.getUrl());
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();       // keeps the page alive; the renderer process is not destroyed
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    public void onBackPressed() {
        // A remote game gets its own WebView: leaving it returns to the connect shell (this phone's entry point),
        // which is still loaded and lets the player pick 本地 or another link.
        if (remoteWeb != null && remoteWeb.getVisibility() == View.VISIBLE) {
            remoteWeb.setVisibility(View.GONE);
            remoteWeb.loadUrl("about:blank");
            web.setVisibility(View.VISIBLE);
            setStatus("已返回连接界面", serverStopped ? "本机服务器已停止（远程模式）" : "");
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("退出游戏？")
                .setMessage("房间和对局保存在这台手机的服务器上，退出会结束所有对局。\n\n（想让朋友继续玩就选「继续游戏」，把手机留在前台。）")
                .setPositiveButton("退出", (d, w) -> finish())
                .setNegativeButton("继续游戏", null)
                .show();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // -----------------------------------------------------------------------------------------------
    // UI
    // -----------------------------------------------------------------------------------------------

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setVisibility(View.GONE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // the game plays music and sound effects on its own
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); // the external web font is https, ours is http
        // Chrome-on-Android in mobile mode: the client's feature detection (touch / coarse pointer / landscape
        // locks / the rotate hint) behaves exactly as it does on a phone browser.
        s.setUserAgentString("Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + "; " + Build.MODEL + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                // The client logs through console.*; forwarding it to logcat makes the WebView debuggable over adb.
                Log.i(TAG, "[js] " + m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        web.setHapticFeedbackEnabled(true);
        // The connect shell (served by the local server at /connect/) talks to the app through this bridge: it asks
        // for the mode it was opened in, opens a verified remote link, and stops the local server when the player
        // moves to another host.
        web.addJavascriptInterface(new Bridge(), "SP_BRIDGE");
        root.addView(web);

        overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setPadding(dp(28), dp(24), dp(28), dp(24));
        overlay.setBackgroundColor(BG);

        TextView title = new TextView(this);
        title.setText("卫戍协议：盟约");
        title.setTextColor(ACCENT);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        overlay.addView(title);

        TextView sub = new TextView(this);
        sub.setText("STRONGHOLD PROTOCOL");
        sub.setTextColor(Color.rgb(0x6E, 0x8A, 0x82));
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        sub.setLetterSpacing(0.35f);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subLp.topMargin = dp(4);
        subLp.bottomMargin = dp(22);
        overlay.addView(sub, subLp);

        status = new TextView(this);
        status.setTextColor(FG);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        status.setGravity(Gravity.CENTER);
        overlay.addView(status);

        detail = new TextView(this);
        detail.setTextColor(Color.rgb(0x8E, 0x9E, 0x99));
        detail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        detail.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams detLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        detLp.topMargin = dp(10);
        overlay.addView(detail, detLp);

        actionButton = new Button(this);
        actionButton.setText("退出");
        actionButton.setVisibility(View.GONE);
        actionButton.setOnClickListener(v -> finish());
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnLp.topMargin = dp(18);
        overlay.addView(actionButton, btnLp);

        root.addView(overlay, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        setStatus("正在启动本机服务器…", "首次启动要解压游戏数据，请稍候");
    }

    private void setStatus(final String text, final String extra) {
        Log.i(TAG, "status: " + text + (extra == null || extra.length() == 0 ? "" : " - " + extra));
        ui.post(new Runnable() {
            @Override
            public void run() {
                status.setText(text);
                detail.setText(extra == null ? "" : extra);
            }
        });
    }

    private void showError(final String text, final String extra, final String buttonLabel, final Runnable onAction) {
        Log.e(TAG, "error screen: " + text + " / " + extra);
        ui.post(new Runnable() {
            @Override
            public void run() {
                status.setText(text);
                status.setTextColor(Color.rgb(0xE7, 0x31, 0x18));
                detail.setText(extra == null ? "" : extra);
                detail.setVisibility(View.VISIBLE);
                actionButton.setText(buttonLabel);
                actionButton.setVisibility(View.VISIBLE);
                actionButton.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        onAction.run();
                    }
                });
            }
        });
    }

    private void loadUrl(final String url) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                overlay.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
                web.loadUrl(url);
                Log.i(TAG, "WebView loading " + url);
                // Opened for a link (share sheet, `adb shell am start … --es connect <url>`): go straight to that
                // host. The connect shell stays loaded underneath, so Back returns to it with a fresh choice.
                if (MODE_REMOTE.equals(sMode) && sRemoteUrl != null) showRemote(sRemoteUrl);
            }
        });
    }

    // -----------------------------------------------------------------------------------------------
    // the shell bridge: remote play, external links, stopping the local server
    // -----------------------------------------------------------------------------------------------

    /** Exposed to the connect shell as `window.SP_BRIDGE` (see mobile/shell/shell.js). */
    private class Bridge {
        /** Whether the page runs inside the app (the shell falls back to plain navigation otherwise). */
        @JavascriptInterface
        public boolean isApp() {
            return true;
        }

        /** `local` or `remote`: how this activity was started. */
        @JavascriptInterface
        public String mode() {
            return sMode;
        }

        /** The remote link the app was opened with, or "". */
        @JavascriptInterface
        public String initialUrl() {
            return sRemoteUrl == null ? "" : sRemoteUrl;
        }

        /**
         * Open a verified remote game in a fresh WebView with its own origin, then stop the local server: the
         * player is a guest of that host, and nothing of ours may keep running behind it.
         */
        @JavascriptInterface
        public void openRemote(final String url) {
            Log.i(TAG, "openRemote " + url);
            ui.post(new Runnable() {
                @Override
                public void run() {
                    showRemote(url);
                }
            });
            stopLocalServer();
        }

        /** Open a link in the device's own browser (used when a link could not be loaded in the app). */
        @JavascriptInterface
        public void openExternal(final String url) {
            Log.i(TAG, "openExternal " + url);
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception e) {
                Log.w(TAG, "no browser for " + url, e);
            }
        }

        /** Stop the local Node server (the shell calls this when the player leaves for another host). */
        @JavascriptInterface
        public void stopLocalServer() {
            MainActivity.this.stopLocalServer();
        }
    }

    /** Show `url` in a second, full-screen WebView (its own origin) and hide the local one. */
    private void showRemote(final String url) {
        if (remoteWeb == null) {
            remoteWeb = new WebView(this);
            remoteWeb.setBackgroundColor(BG);
            remoteWeb.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            WebSettings s = remoteWeb.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setUseWideViewPort(true);
            s.setLoadWithOverviewMode(true);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            s.setUserAgentString("Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + "; " + Build.MODEL + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
            remoteWeb.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String loadedUrl) {
                    // The remote host now serves and simulates the game itself; ours has nothing left to do.
                    stopLocalServer();
                }
            });
            remoteWeb.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                    Log.i(TAG, "[remote js] " + m.message());
                    return true;
                }
            });
            root.addView(remoteWeb);
        }
        remoteWeb.setVisibility(View.VISIBLE);
        remoteWeb.loadUrl(url);
        setStatus("正在连接远程主机…", url);
        ui.post(new Runnable() {
            @Override
            public void run() {
                // keep the shell behind it: if the remote page is closed, the player can pick again
                web.setVisibility(View.GONE);
                overlay.setVisibility(View.GONE);
            }
        });
    }

    /** Ask the local Node server to exit (SIGTERM), so remote play does not keep a server running behind it. */
    private void stopLocalServer() {
        if (serverStopped) return;
        serverStopped = true;
        final Process proc = nodeProcess;
        if (proc == null) {
            Log.i(TAG, "no local server process to stop");
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    // Android has no signals for arbitrary processes; `kill -TERM` on our own pid does the job and
                    // reaches the graceful path in mobile/node/main.js (rooms get room.closed).
                    Runtime.getRuntime().exec(new String[] { "kill", "-TERM", String.valueOf(pidOf(proc)) }).waitFor();
                } catch (Exception e) {
                    Log.w(TAG, "cannot signal the local server: " + e.getMessage());
                    proc.destroy();
                }
                Log.i(TAG, "local server asked to stop");
            }
        }, "sp-stop").start();
    }

    /** The pid of a spawned process (reflection: `Process.pid()` is API 24+, this app supports 24 already). */
    private static int pidOf(Process proc) {
        try {
            return (int) Process.class.getMethod("pid").invoke(proc);
        } catch (Exception e) {
            return -1;
        }
    }

    // -----------------------------------------------------------------------------------------------
    // start-up pipeline
    // -----------------------------------------------------------------------------------------------

    private void startEverything() {
        if (sServerStarted) {
            if (handshake != null && handshake.optString("url", null) != null) loadUrl(handshake.optString("url"));
            else setStatus("服务器已在运行…", "正在等待本机服务器");
            return;
        }
        sServerStarted = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                copyProjectIfNeeded();
            }
        }, "sp-copy").start();
    }

    private File projectDir() {
        return new File(getFilesDir(), PROJECT);
    }

    /**
     * The directory that holds the Node runtime: `ApplicationInfo.nativeLibraryDir`, i.e. where Android extracts
     * the APK's `lib/<abi>/` entries. The APK ships one runtime per ABI — arm64 for phones, x86_64 for the usual
     * Android emulators (MuMu, LDPlayer, BlueStacks, AOSP/Play images) — and Android unpacks only the ABI the
     * device needs, while `nativeLibraryDir` names exactly one of them (`lib/arm64` on a phone, `lib/x86_64` on an
     * x86 emulator). The candidates below cover both spellings plus the device's own ABI list, so the right runtime
     * is found either way; a device that got none (an emulator whose native bridge cannot run our code) reports a
     * clear error instead of failing to start.
     *
     * The runtime executable is called `libnode.so`, not `node`: Android only extracts `lib*.so` shaped entries
     * from `lib/` (see the packager's `stageRuntime`), and the executable is renamed together with its libraries'
     * ELF records.
     */
    private static final String RUNTIME_EXECUTABLE = "libnode.so";

    private File runtimeDir() {
        File primary = new File(getApplicationInfo().nativeLibraryDir);
        File libRoot = primary.getParentFile();
        List<File> candidates = new ArrayList<File>();
        candidates.add(primary);
        if (libRoot != null) {
            String name = primary.getName();                                    // "arm64" / "x86_64"
            candidates.add(new File(libRoot, name + "-v8a"));                   // lib/arm64   -> lib/arm64-v8a
            candidates.add(new File(libRoot, name.replace('_', '-')));          // lib/x86_64  -> lib/x86-64
            candidates.add(new File(libRoot, "arm64-v8a"));
            candidates.add(new File(libRoot, "x86_64"));
        }
        for (String abi : Build.SUPPORTED_ABIS) {
            if (libRoot != null) candidates.add(new File(libRoot, abi));
        }
        for (File dir : candidates) {
            if (dir.isDirectory() && new File(dir, RUNTIME_EXECUTABLE).isFile()) return dir;
        }
        Log.w(TAG, "no runtime directory containing " + RUNTIME_EXECUTABLE + "; looked at " + candidates);
        return primary;
    }

    /** The Node executable in {@link #runtimeDir()}. */
    private File runtimeNode() {
        return new File(runtimeDir(), RUNTIME_EXECUTABLE);
    }

    /** The ABIs this APK carries a runtime for (the `lib/` entries), for the error message. */
    private String runtimeAbis() {
        File libRoot = new File(getApplicationInfo().nativeLibraryDir).getParentFile();
        if (libRoot == null) return "?";
        String[] dirs = libRoot.list();
        if (dirs == null || dirs.length == 0) return "?";
        StringBuilder sb = new StringBuilder();
        for (String d : dirs) {
            if (sb.length() > 0) sb.append(", ");
            sb.append(d);
        }
        return sb.toString();
    }

    private boolean wasApkUpdated() {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long last = 0;
        String version = "";
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            last = pi.lastUpdateTime;
            version = pi.versionName == null ? "" : pi.versionName;
        } catch (Exception e) {
            Log.w(TAG, "package info unavailable", e);
        }
        boolean changed = last != prefs.getLong(K_LAST_UPDATE, 0) || !version.equals(prefs.getString(K_VERSION, ""));
        prefs.edit().putLong(K_LAST_UPDATE, last).putString(K_VERSION, version).apply();
        return changed;
    }

    /**
     * Unpack `assets/nodejs-project` into the app's files directory.
     *
     * Copying ~262 MB is only done when it is actually needed: the shipped art has its own marker file
     * (`public/ASSETS-VERSION`), so an update that only changes code (the usual case) rewrites a few megabytes of
     * scripts while the art stays in place — Android's in-place update keeps the app's data directory.
     */
    private void copyProjectIfNeeded() {
        try {
            File dir = projectDir();
            boolean apkChanged = wasApkUpdated();
            String assetsVersion = apkChanged ? "" : readAssetText(PROJECT + "/public/ASSETS-VERSION");
            boolean needCode = apkChanged || !new File(dir, "mobile/node/main.js").isFile();
            boolean needArt = apkChanged || assetsVersion.length() == 0
                    || !assetsVersion.equals(readFileText(new File(dir, "public/ASSETS-VERSION")))
                    || !new File(dir, "public/index.html").isFile();
            Log.i(TAG, "copy: apkChanged=" + apkChanged + " needCode=" + needCode + " needArt=" + needArt);

            // `shell` carries the connect page (本地/远程); it is small and always refreshed, so it can change with
            // a normal update without re-unpacking the art.
            String[] parts = { "server", "shared", "data", "docs", "mobile", "node_modules", "shell" };
            if (needCode) {
                for (String part : parts) deleteRecursively(new File(dir, part));
                deleteRecursively(new File(dir, "package.json"));
                deleteRecursively(new File(dir, "BUILD-INFO.json"));
                long t0 = System.currentTimeMillis();
                setStatus("正在解压游戏程序…", "首次启动或更新后需要重建数据（约 30 秒）");
                for (String part : parts) copyAssetFolder(getAssets(), PROJECT + "/" + part, new File(dir, part));
                copyAssetFile(getAssets(), PROJECT + "/package.json", new File(dir, "package.json"));
                copyAssetFile(getAssets(), PROJECT + "/BUILD-INFO.json", new File(dir, "BUILD-INFO.json"));
                Log.i(TAG, "program copied in " + (System.currentTimeMillis() - t0) + " ms");
            }
            if (needArt) {
                deleteRecursively(new File(dir, "public"));
                long t0 = System.currentTimeMillis();
                setStatus("正在解压美术与音频…", "仅首次（约 4000 个文件 / 262 MB）");
                copyAssetFolder(getAssets(), PROJECT + "/public", new File(dir, "public"));
                Log.i(TAG, "art copied in " + (System.currentTimeMillis() - t0) + " ms");
            }
        } catch (Exception e) {
            Log.e(TAG, "asset copy failed", e);
            showError("无法解压游戏数据", String.valueOf(e.getMessage()), "退出", new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
            return;
        }
        setStatus("正在启动本机服务器…", "Node.js 24 (Termux runtime)");
        startNode();
    }

    // -----------------------------------------------------------------------------------------------
    // starting Node
    // -----------------------------------------------------------------------------------------------

    private void startNode() {
        final File dir = projectDir();
        final File node = runtimeNode();
        final File handshakeFile = new File(getFilesDir(), "handshake.json");
        if (!node.isFile()) {
            showError("Node 运行时缺失",
                    "找不到 " + node.getAbsolutePath() + "。\n这个 APK 是否用 --no-node 构建？或者设备的 CPU 架构不在 APK 内"
                            + "（APK 支持 " + runtimeAbis() + "，本机是 " + Build.SUPPORTED_ABIS[0] + "）。",
                    "退出", new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
            return;
        }
        if (!node.canExecute() && !node.setExecutable(true, false)) {
            Log.w(TAG, "cannot mark " + node + " executable; relying on the linker fallback");
        }
        if (handshakeFile.exists() && !handshakeFile.delete()) Log.w(TAG, "stale handshake not removed");

        final List<String> nodeArgs = new ArrayList<String>();
        nodeArgs.add(node.getAbsolutePath());
        nodeArgs.add(new File(dir, "mobile/node/main.js").getAbsolutePath());
        nodeArgs.add("--public");
        nodeArgs.add(new File(dir, "public").getAbsolutePath());
        nodeArgs.add("--data");
        nodeArgs.add(new File(dir, "data").getAbsolutePath());
        nodeArgs.add("--handshake");
        nodeArgs.add(handshakeFile.getAbsolutePath());
        nodeArgs.add("--host");
        nodeArgs.add("0.0.0.0");
        nodeArgs.add("--port");
        nodeArgs.add("0");

        new Thread(new Runnable() {
            @Override
            public void run() {
                Integer exit = runNode(nodeArgs, false);
                if (exit == null) {
                    Log.i(TAG, "direct exec unavailable - retrying through /system/bin/linker64");
                    setStatus("正在启动本机服务器…", "通过系统动态链接器启动 Node");
                    exit = runNode(nodeArgs, true);
                }
                if (exit == null || exit.intValue() != 0) {
                    showError("本机服务器已停止", "Node.js 退出码 " + (exit == null ? "?" : exit)
                            + "；请退出后重新打开应用（日志：adb logcat -s StrongholdProtocol）", "退出", new Runnable() {
                        @Override
                        public void run() {
                            finish();
                        }
                    });
                }
            }
        }, "sp-node").start();
        new Thread(new Runnable() {
            @Override
            public void run() {
                watchHandshake(handshakeFile);
            }
        }, "sp-watch").start();
    }

    /**
     * Run the runtime once. Returns its exit code, or null when the process could not be started at all
     * (`execve` denied) — the caller then retries through the linker.
     */
    private Integer runNode(List<String> nodeArgs, boolean viaLinker) {
        List<String> cmd = new ArrayList<String>();
        if (viaLinker) cmd.add("/system/bin/linker64");
        cmd.addAll(nodeArgs);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(projectDir());
        pb.redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.put("HOME", getFilesDir().getAbsolutePath());
        env.put("TMPDIR", getCacheDir().getAbsolutePath());
        env.put("LANG", "zh_CN.UTF-8");
        env.put("NODE_OPTIONS", "--max-old-space-size=2048");
        // the runtime's libraries live next to the executable (libc++, openssl, icu, …); that is the ABI directory
        // the executable was found in, not necessarily `nativeLibraryDir`
        String runtimeDir = runtimeDir().getAbsolutePath();
        env.put("LD_LIBRARY_PATH", runtimeDir);
        env.put("PATH", runtimeDir + ":/system/bin:/system/xbin");
        Process proc;
        try {
            proc = pb.start();
        } catch (IOException e) {
            Log.w(TAG, "cannot start Node" + (viaLinker ? " via linker64" : "") + ": " + e.getMessage());
            return null;
        }
        final Process running = proc;
        nodeProcess = proc; // so `stopLocalServer()` can signal it when the player moves to a remote host
        // The server prints its banner and every `[mobile] ...` line; forward them to logcat.
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    BufferedReader r = new BufferedReader(new InputStreamReader(running.getInputStream(), StandardCharsets.UTF_8));
                    String line;
                    while ((line = r.readLine()) != null) Log.i(TAG, "node: " + line);
                } catch (IOException ignored) {
                    // the process ended
                }
            }
        }, "sp-node-log").start();
        try {
            int code = proc.waitFor();
            Log.i(TAG, "Node exited with " + code + (viaLinker ? " (linker64)" : ""));
            return Integer.valueOf(code);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Integer.valueOf(0);
        }
    }

    /** Poll for the handshake file; main.js writes it only after /healthz and a WebSocket upgrade both answered. */
    private void watchHandshake(File file) {
        long deadline = System.currentTimeMillis() + START_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (file.isFile()) {
                try {
                    JSONObject json = new JSONObject(new String(readAll(file), StandardCharsets.UTF_8));
                    String error = json.optString("error", "");
                    if (error.length() > 0) {
                        showError("服务器启动失败", error, "退出", new Runnable() {
                            @Override
                            public void run() {
                                finish();
                            }
                        });
                        return;
                    }
                    String url = json.optString("url", "");
                    if (url.length() > 0) {
                        handshake = json;
                        String lan = lanList(json.optJSONArray("lan"));
                        // The server tells us where a *local* player should land: the connect shell (本地/远程) when
                        // it is bundled, the game's own entry point otherwise.
                        String entry = json.optString("connectUrl", url);
                        Log.i(TAG, "server ready on " + url + "  entry=" + entry + (lan.length() == 0 ? "" : "  lan=" + lan)
                                + "  node=" + json.optString("node", "?"));
                        setStatus("服务器已就绪，正在打开连接界面…", lan.length() == 0 ? "正在加载客户端" : "局域网地址：" + lan);
                        loadUrl(entry);
                        return;
                    }
                } catch (Exception e) {
                    Log.w(TAG, "handshake not readable yet: " + e.getMessage());
                }
            }
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                return;
            }
        }
        showError("服务器启动超时", "超过 " + (START_TIMEOUT_MS / 1000) + " 秒未就绪。请退出后重试；仍失败请查看日志：adb logcat -s StrongholdProtocol", "退出", new Runnable() {
            @Override
            public void run() {
                finish();
            }
        });
    }

    private static String lanList(JSONArray arr) {
        if (arr == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < arr.length() && i < 3; i++) {
            if (sb.length() > 0) sb.append("  ");
            sb.append(arr.optString(i, ""));
        }
        return sb.toString();
    }

    // -----------------------------------------------------------------------------------------------
    // asset copying (following the "copy the node project into FilesDir" helper of the nodejs-mobile guide)
    // -----------------------------------------------------------------------------------------------

    /** Recursively copy an asset directory (a directory whose `list()` is non-empty). */
    private static void copyAssetFolder(AssetManager am, String from, File to) throws IOException {
        String[] children = am.list(from);
        if (children == null || children.length == 0) {
            copyAssetFile(am, from, to);
            return;
        }
        if (!to.isDirectory() && !to.mkdirs()) throw new IOException("cannot create " + to);
        for (String child : children) copyAssetFolder(am, from + "/" + child, new File(to, child));
    }

    private static void copyAssetFile(AssetManager am, String from, File to) throws IOException {
        if (to.getParentFile() != null) to.getParentFile().mkdirs();
        InputStream in = null;
        OutputStream out = null;
        try {
            in = am.open(from);
            out = new FileOutputStream(to);
            byte[] buf = new byte[128 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // nothing to do
                }
            }
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                    // nothing to do
                }
            }
        }
    }

    /** Read a small text file out of the APK's assets, or "" when it is absent. */
    private String readAssetText(String path) {
        InputStream in = null;
        try {
            in = getAssets().open(path);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8).trim();
        } catch (Exception e) {
            return "";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // nothing to do
                }
            }
        }
    }

    private static String readFileText(File f) {
        try {
            return new String(readAll(f), StandardCharsets.UTF_8).trim();
        } catch (Exception e) {
            return "";
        }
    }

    private static byte[] readAll(File f) throws IOException {
        InputStream in = null;
        try {
            in = new FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // nothing to do
                }
            }
        }
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteRecursively(c);
        }
        if (!f.delete()) Log.w(TAG, "cannot delete " + f);
    }
}
