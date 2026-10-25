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
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.content.res.AssetFileDescriptor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceResponse;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.FilterInputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {
    private static final String TAG = "StrongholdProtocol";
    private static final String PREFS = "sp_android";
    private static final String K_OPEN_LAN = "openLan";
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
    private static volatile boolean sServerStarted = false;
    private static volatile boolean sStopping = false;
    private static volatile Process sNodeProcess;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private LinearLayout overlay;
    private TextView status;
    private TextView detail;
    private Button actionButton;
    private LinearLayout networkChoice;
    private Button networkEnableButton;
    private Button networkDisableButton;
    private JSONObject handshake;
    private PreferenceStore preferences;
    private volatile String preferenceOrigin;
    private AlertDialog sslDialog;
    private String localServerUrl;
    private boolean remoteServerConfirmed;
    private String remoteCheckToken;
    /** Remote page origin whose /assets|fonts|media|icons requests may be answered from the APK. */
    private volatile String remoteArtOrigin;
    /** Origins of the remote page and its asset hosts (from the remote asset manifests). */
    private volatile Set<String> remoteArtOrigins = Collections.emptySet();
    /** Path prefixes before /assets|fonts|media|icons on those hosts ('' and e.g. '/Stronghold-Protocol'). */
    private volatile List<String> remoteArtPrefixes = Collections.emptyList();
    /** strict (hash/manifest matching) or local-first (any packaged file). */
    private volatile String remoteArtMode = "local-first";
    /** Whether the remote healthz assets fingerprint equals this APK's assets manifest. */
    private volatile boolean remoteAssetMatch = false;
    /** Entry link, resolved game URL and the admitted origin; empty outside a remote session. */
    private volatile String remoteRequestedUrl;
    private volatile String remoteFinalUrl;
    private volatile String remoteGameOrigin;
    private volatile String remoteVerification;
    /** Intermediate redirect origins are navigable only during the one-shot entry chain. */
    private volatile Set<String> remoteRedirectOrigins = Collections.emptySet();
    /** The entry link may follow its one-shot redirect chain; after landing only the game origin is allowed. */
    private volatile boolean remoteEntryRedirectPending = false;
    /** Set from the settings page; the next remote page unregisters its SW and clears Cache Storage once. */
    private volatile boolean pendingRemoteCacheClear = false;
    /** URL → packaged file metadata, loaded from assets/nodejs-project/art-index.tsv. */
    private volatile Map<String, ArtEntry> artIndex;
    private final Object artIndexLock = new Object();
    private volatile boolean artIndexLoading = false;
    private volatile boolean artIndexFailed = false;
    private final AtomicInteger artHits = new AtomicInteger();
    private final AtomicInteger artMisses = new AtomicInteger();
    private final AtomicInteger artSeen = new AtomicInteger();
    /** Collect the remote page's own match records into the on-device archive (settings toggle, default on). */
    private volatile boolean remoteCollectStats = true;
    /** Remote server app version from the entry health probe; provenance for collected records. */
    private volatile String remoteAppVersion = "";
    private ScheduledExecutorService statsExec;
    private ScheduledFuture<?> statsBackstop;
    private final Object statsExecLock = new Object();
    /** Durable local match statistics: filesDir/local-stats.json is authoritative, localStorage is a mirror. */
    private StatsStore statsStore;
    /** Current main-frame URL, used by the bridge guard without calling WebView from the JavaBridge thread. */
    private volatile String currentPageUrl;
    /** One pending WebView file chooser (statistics import). */
    private ValueCallback<Uri[]> fileChooserCallback;
    private String pendingExportText;
    private String pendingExportName;
    private static final int REQ_STATS_EXPORT = 4101;
    private static final int REQ_STATS_IMPORT = 4102;

    // -----------------------------------------------------------------------------------------------
    // activity lifecycle
    // -----------------------------------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Log.i(TAG, "onCreate: sdk=" + Build.VERSION.SDK_INT + " abi=" + Build.SUPPORTED_ABIS[0] + " node=" + processAlive(sNodeProcess));
        buildUi();
        // A remote page is never restored without its probe/policy; reopen it from the local entry.
        if (sServerStarted && processAlive(sNodeProcess)) {
            handshake = readValidHandshake(new File(getFilesDir(), "handshake.json"));
            if (handshake != null) localServerUrl = handshake.optString("url", null);
            startEverything();
        } else {
            showNetworkChoice();
        }
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
    protected void onDestroy() {
        if (sslDialog != null && sslDialog.isShowing()) sslDialog.dismiss();
        if (fileChooserCallback != null) {
            // leaving a file input pending forever would break the next 导入 tap
            try { fileChooserCallback.onReceiveValue(null); } catch (Exception ignored) { /* webview gone */ }
            fileChooserCallback = null;
        }
        if (isRemoteSession() && remoteCollectStats && statsExec != null) {
            statsExec.execute(() -> runStatsPull("destroy"));
        }
        if (isFinishing() && !isChangingConfigurations()) stopNodeProcess("activity finished");
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_STATS_IMPORT) {
            ValueCallback<Uri[]> callback = fileChooserCallback;
            fileChooserCallback = null;
            if (callback == null) return;
            Uri uri = data == null ? null : data.getData();
            callback.onReceiveValue(resultCode == RESULT_OK && uri != null ? new Uri[]{uri} : null);
            Log.i(TAG, "[stats-file] import picker " + (resultCode == RESULT_OK && uri != null ? "uri=" + uri : "cancelled"));
            return;
        }
        if (requestCode == REQ_STATS_EXPORT) {
            final String text = pendingExportText;
            final String name = pendingExportName;
            pendingExportText = null;
            pendingExportName = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                Toast.makeText(this, "已取消导出", Toast.LENGTH_SHORT).show();
                Log.i(TAG, "[stats-file] export cancelled");
                return;
            }
            if (text == null) return;
            Uri uri = data.getData();
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new IOException("no output stream");
                out.write(text.getBytes(StandardCharsets.UTF_8));
                String shown = displayNameOf(uri, name == null ? "stronghold-stats.json" : name);
                showExportResult(shown);
                Log.i(TAG, "[stats-file] export saf saved name=" + shown + " bytes=" + text.length());
            } catch (Exception e) {
                Log.w(TAG, "[stats-file] export saf write failed", e);
                Toast.makeText(this, "导出失败", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (isRemoteSession()) {
            AlertDialog.Builder builder = new AlertDialog.Builder(this)
                    .setTitle("离开远程页面？")
                    .setMessage("本地游戏服务仍在运行。可以返回本机入口，也可以继续留在远程页面。")
                    .setPositiveButton("继续游戏", null)
                    .setNegativeButton("退出应用", (d, w) -> finish());
            if (localServerUrl != null) {
                builder.setNeutralButton("返回本地入口", (d, w) -> returnToLocalTitle());
            }
            builder.show();
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

    private StateListDrawable choiceBackground(int normalColor, int pressedColor, int strokeColor) {
        StateListDrawable states = new StateListDrawable();
        GradientDrawable pressed = new GradientDrawable();
        pressed.setColor(pressedColor);
        pressed.setStroke(dp(1), strokeColor);
        pressed.setCornerRadius(dp(2));
        GradientDrawable normal = new GradientDrawable();
        normal.setColor(normalColor);
        normal.setStroke(dp(1), strokeColor);
        normal.setCornerRadius(dp(2));
        states.addState(new int[]{android.R.attr.state_pressed}, pressed);
        states.addState(new int[]{}, normal);
        return states;
    }

    // -----------------------------------------------------------------------------------------------
    // UI
    // -----------------------------------------------------------------------------------------------

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        preferences = new PreferenceStore(getFilesDir());
        statsStore = new StatsStore();
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
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setGeolocationEnabled(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Chrome-on-Android in mobile mode: the client's feature detection (touch / coarse pointer / landscape
        // locks / the rotate hint) behaves exactly as it does on a phone browser.
        s.setUserAgentString("Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + "; " + Build.MODEL + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
        web.addJavascriptInterface(new LocalBridge(), "SP_BRIDGE");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                preferencePage = url;
                currentPageUrl = url;
                if (isRemoteSession()) {
                    Uri uri = Uri.parse(url);
                    // A remote server redirecting itself to this app's own loopback/LAN server is
                    // never allowed, even though that URL would otherwise look "local".
                    if (!allowRemoteNavigation(uri)) {
                        blockRemoteNavigation(url);
                        return;
                    }
                    String leavingOrigin = originOf(uri);
                    if (remoteCollectStats && leavingOrigin != null && !leavingOrigin.equals(remoteGameOrigin)) {
                        statsExecutor().execute(() -> runStatsPull("leave"));
                    }
                    String origin = originOf(uri);
                    if (origin != null && !isBlockedRemoteUri(uri)
                            && (origin.equals(remoteGameOrigin) || origin.equals(originOfUrl(remoteFinalUrl)))) {
                        rememberRemoteOrigin(origin);
                        if (origin.equals(remoteGameOrigin) || origin.equals(originOfUrl(remoteFinalUrl))) {
                            remoteEntryRedirectPending = false;
                        }
                    }
                } else if (isLocalPageUrl(url)) {
                    resetRemotePolicy();
                }
                if (!isPreferenceOrigin(url)) disableLocalPreferences();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (handleInternalRemoteCallback(view, request.getUrl())) return true;
                String target = request.getUrl().toString();
                if (isRemoteSession()) {
                    boolean allowed = request.isForMainFrame()
                            ? allowRemoteNavigation(request.getUrl()) : allowRemoteSubframe(request.getUrl());
                    if (!allowed) { blockRemoteNavigation(target, request.isForMainFrame()); return true; }
                    if (!request.isForMainFrame()) return false;
                }
                if (!request.isForMainFrame()) return !isPreferenceOrigin(target);
                if (isPreferenceOrigin(view.getUrl()) && !isPreferenceOrigin(target)) {
                    Log.w(TAG, "[remote] blocked a local page link to an unprobed URL " + target);
                    return true;
                }
                return false;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (handleInternalRemoteCallback(view, Uri.parse(url))) return true;
                Uri target = Uri.parse(url);
                if (isRemoteSession()) {
                    if (!allowRemoteNavigation(target)) { blockRemoteNavigation(url); return true; }
                }
                if (isPreferenceOrigin(view.getUrl()) && !isPreferenceOrigin(url)) {
                    Log.w(TAG, "[remote] blocked a local page link to an unprobed URL " + url);
                    return true;
                }
                return false;
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                super.doUpdateVisitedHistory(view, url, isReload);
                if (!isRemoteSession() || url == null || isLocalPageUrl(url)) return;
                Uri uri = Uri.parse(url);
                if (!allowRemoteNavigation(uri)) { blockRemoteNavigation(url); return; }
                String origin = originOf(uri);
                if (origin != null && (origin.equals(remoteGameOrigin) || origin.equals(originOfUrl(remoteFinalUrl)))) {
                    rememberRemoteOrigin(origin);
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                showCertificateConfirmation(handler, error);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (isRemoteSession()) {
                    if (pendingRemoteCacheClear) {
                        pendingRemoteCacheClear = false;
                        clearRemotePageCachesOnce();
                    }
                    Log.i(TAG, "[art] summary hits=" + artHits.get() + " misses=" + artMisses.get()
                            + " seen=" + artSeen.get() + " mode=" + remoteArtMode
                            + " verification=" + remoteVerification);
                }
                inspectRemoteGamePage(url);
                installRemoteStatsHook(url);
                if (!isRemoteSession() && isLocalPageUrl(url)) migrateLocalStats();
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse local = interceptLocalArt(request);
                return local != null ? local : super.shouldInterceptRequest(view, request);
            }
        });
        // Requests made by a service worker (e.g. the upstream /sw.js fetch) use their own client on API 24+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                        return interceptLocalArt(request);
                    }
                });
            } catch (Throwable t) {
                Log.w(TAG, "ServiceWorker interception unavailable", t);
            }
        }
        loadArtIndex();
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                // The client logs through console.*; forwarding it to logcat makes the WebView debuggable over adb.
                String consoleText = m.message();
                if (consoleText != null && consoleText.startsWith("[sp-stats-dirty]")) {
                    scheduleStatsPull("dirty", 2000);
                    return true;
                }
                Log.i(TAG, "[js] " + consoleText + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
                Log.w(TAG, "[remote] blocked window.open");
                return false;
            }

            @Override
            public void onPermissionRequest(android.webkit.PermissionRequest request) {
                Log.w(TAG, "[remote] denied a WebView permission request");
                request.deny();
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             WebChromeClient.FileChooserParams params) {
                if (isRemoteSession() || !isLocalPageUrl(currentPageUrl)) {
                    Log.w(TAG, "[stats-file] blocked remote file chooser " + currentPageUrl);
                    return false;
                }
                if (fileChooserCallback != null) {
                    try { fileChooserCallback.onReceiveValue(null); } catch (Exception ignored) { /* replaced */ }
                }
                fileChooserCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_MIME_TYPES,
                            new String[]{"application/json", "text/json", "text/plain", "application/octet-stream"});
                    startActivityForResult(Intent.createChooser(intent, "选择统计文件"), REQ_STATS_IMPORT);
                    Log.i(TAG, "[stats-file] import picker opened");
                    return true;
                } catch (Exception e) {
                    fileChooserCallback = null;
                    Log.w(TAG, "[stats-file] import picker failed", e);
                    return false;
                }
            }
        });
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                Log.w(TAG, "[remote] blocked download " + url));
        web.setHapticFeedbackEnabled(true);
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

        networkChoice = new LinearLayout(this);
        networkChoice.setOrientation(LinearLayout.VERTICAL);
        networkChoice.setGravity(Gravity.CENTER_HORIZONTAL);
        LinearLayout.LayoutParams choiceLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        choiceLp.topMargin = dp(18);

        TextView choicePrompt = new TextView(this);
        choicePrompt.setText("是否开启局域网联机");
        choicePrompt.setTextColor(FG);
        choicePrompt.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        choicePrompt.setGravity(Gravity.CENTER);
        networkChoice.addView(choicePrompt);

        TextView choiceHint = new TextView(this);
        choiceHint.setText("开启允许同一局域网设备加入；关闭仅当前设备访问");
        choiceHint.setTextColor(Color.rgb(0x8E, 0x9E, 0x99));
        choiceHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        choiceHint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.topMargin = dp(7);
        networkChoice.addView(choiceHint, hintLp);

        LinearLayout choiceButtons = new LinearLayout(this);
        choiceButtons.setOrientation(LinearLayout.HORIZONTAL);
        choiceButtons.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams buttonsLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonsLp.topMargin = dp(14);

        networkEnableButton = new Button(this);
        networkEnableButton.setText("开启");
        networkEnableButton.setAllCaps(false);
        networkEnableButton.setTextColor(BG);
        networkEnableButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        networkEnableButton.setGravity(Gravity.CENTER);
        networkEnableButton.setPadding(dp(22), dp(8), dp(22), dp(8));
        networkEnableButton.setBackground(choiceBackground(ACCENT, Color.rgb(0x36, 0xA8, 0x87), ACCENT));
        networkEnableButton.setOnClickListener(v -> chooseNetworkMode(true));
        LinearLayout.LayoutParams enableLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        enableLp.rightMargin = dp(5);
        choiceButtons.addView(networkEnableButton, enableLp);

        networkDisableButton = new Button(this);
        networkDisableButton.setText("关闭");
        networkDisableButton.setAllCaps(false);
        networkDisableButton.setTextColor(FG);
        networkDisableButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        networkDisableButton.setGravity(Gravity.CENTER);
        networkDisableButton.setPadding(dp(22), dp(8), dp(22), dp(8));
        networkDisableButton.setBackground(choiceBackground(Color.TRANSPARENT, Color.rgb(0x22, 0x2B, 0x28), FG));
        networkDisableButton.setOnClickListener(v -> chooseNetworkMode(false));
        LinearLayout.LayoutParams disableLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        disableLp.leftMargin = dp(5);
        choiceButtons.addView(networkDisableButton, disableLp);

        networkChoice.addView(choiceButtons, buttonsLp);
        overlay.addView(networkChoice, choiceLp);

        root.addView(overlay, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        setStatus("等待联机设置", "请选择开启或关闭，选择后才会启动游戏服务");
    }

    private void showNetworkChoice() {
        if (networkChoice != null) networkChoice.setVisibility(View.VISIBLE);
        if (actionButton != null) actionButton.setVisibility(View.GONE);
        if (status != null) status.setTextColor(FG);
        setStatus("等待联机设置", "请选择开启或关闭，选择后才会启动游戏服务");
    }

    private void chooseNetworkMode(boolean openLan) {
        if (sServerStarted || processAlive(sNodeProcess)) return;
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(K_OPEN_LAN, openLan).apply();
        if (networkEnableButton != null) networkEnableButton.setEnabled(false);
        if (networkDisableButton != null) networkDisableButton.setEnabled(false);
        if (networkChoice != null) networkChoice.setVisibility(View.GONE);
        setStatus("正在启动本机游戏服务…", openLan ? "局域网联机已开启" : "局域网联机已关闭，仅当前设备访问");
        startEverything();
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

    private boolean isPreferenceOrigin(String url) {
        try {
            Uri u = Uri.parse(url);
            return preferenceOrigin != null && "http".equals(u.getScheme())
                    && "127.0.0.1".equals(u.getHost()) && u.getUserInfo() == null
                    && preferenceOrigin.equals("http://127.0.0.1:" + u.getPort());
        } catch (Exception e) { return false; }
    }

    private void disableLocalPreferences() {
        preferences.setEnabled(false);
        web.removeJavascriptInterface("SP_PREFERENCES");
    }

    private void enableLocalPreferences(String url) {
        // Trust only the current validated Node handshake, never arbitrary loopback pages.
        String expected = handshake == null ? null : handshake.optString("url", null);
        if (expected == null || !expected.equals(url)) { disableLocalPreferences(); return; }
        Uri u = Uri.parse(expected);
        preferenceOrigin = "http://127.0.0.1:" + u.getPort();
        preferences.setEnabled(true);
        web.addJavascriptInterface(preferences, "SP_PREFERENCES");
    }

    private volatile String preferencePage;

    private void loadUrl(final String url) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                overlay.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
                preferencePage = url;
                currentPageUrl = url;
                enableLocalPreferences(url);
                if (isLocalPageUrl(url)) resetRemotePolicy();
                web.loadUrl(url);
                Log.i(TAG, "WebView loading " + url);
            }
        });
    }

    // -----------------------------------------------------------------------------------------------
    // durable local statistics: filesDir/local-stats.json is authoritative (app updates keep filesDir);
    // localStorage stays a mirror so the browser build and older installations keep working.
    // -----------------------------------------------------------------------------------------------

    private boolean isLocalBridgeAllowed() {
        if (web == null || statsStore == null || isRemoteSession()) return false;
        String url = currentPageUrl;
        return url != null && isLocalPageUrl(url);
    }

    /** One-time bridge from the legacy WebView localStorage envelope into filesDir. */
    private void migrateLocalStats() {
        if (web == null || statsStore == null || isRemoteSession() || !isLocalPageUrl(currentPageUrl)) return;
        if (statsStore.hasStore()) {
            Log.i(TAG, "[stats-store] migrate skip (store exists)");
            return;
        }
        web.evaluateJavascript("(function(){try{return localStorage.getItem('sp.pref.stats')||''}catch(e){return ''}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (isRemoteSession() || !isLocalPageUrl(currentPageUrl)) return;
                        statsExecutor().execute(() -> {
                            try {
                                Object decoded = new org.json.JSONTokener(value == null ? "" : value).nextValue();
                                if (!(decoded instanceof String)) return;
                                String raw = (String) decoded;
                                if (raw.isEmpty()) {
                                    Log.i(TAG, "[stats-store] migrate nothing to migrate");
                                    return;
                                }
                                if (statsStore.write(raw)) Log.i(TAG, "[stats-store] migrated bytes=" + raw.length());
                                else Log.w(TAG, "[stats-store] migrate rejected bytes=" + raw.length());
                            } catch (Exception e) {
                                Log.w(TAG, "[stats-store] migrate failed to decode", e);
                            }
                        });
                    }
                });
    }

    private final class StatsStore {
        private static final long MAX_CHARS = 4_000_000L;
        private final File primary = new File(getFilesDir(), "local-stats.json");
        private final File backup = new File(getFilesDir(), "local-stats.bak.json");
        private final File external;
        private String cached;
        private boolean loaded;
        private boolean externalMirrorFailed;

        StatsStore() {
            File extDir = getExternalFilesDir(null);
            external = extDir == null ? null : new File(extDir, "local-stats.json");
            Log.i(TAG, "[stats-store] primary=" + primary.getAbsolutePath()
                    + " mirror=" + (external == null ? "none" : external.getAbsolutePath()));
        }

        synchronized boolean hasStore() {
            return primary.isFile() || (external != null && external.isFile());
        }

        synchronized String read() {
            if (loaded) {
                Log.i(TAG, "[stats-store] read source=cache bytes=" + (cached == null ? 0 : cached.length()));
                return cached;
            }
            loaded = true;
            File[] files = new File[]{primary, external, backup};
            String[] names = new String[]{"primary", "external", "bak"};
            for (int i = 0; i < files.length; i++) {
                File file = files[i];
                if (file == null || !file.isFile()) continue;
                String raw = readText(file);
                if (isEnvelope(raw)) {
                    cached = raw;
                    if (i > 0 && writePrimary(raw)) {
                        Log.i(TAG, "[stats-store] restored " + names[i] + " to primary");
                    }
                    Log.i(TAG, "[stats-store] read source=" + names[i] + " bytes=" + raw.length());
                    return cached;
                }
                if (i == 0) quarantine(primary);
                Log.w(TAG, "[stats-store] " + names[i] + " is not a stats envelope");
            }
            Log.i(TAG, "[stats-store] read source=none bytes=0");
            return null;
        }

        synchronized boolean write(String raw) {
            if (raw == null || raw.length() > MAX_CHARS) {
                Log.w(TAG, "[stats-store] reject bytes=" + (raw == null ? -1 : raw.length()));
                return false;
            }
            if (!isEnvelope(raw)) {
                Log.w(TAG, "[stats-store] reject invalid envelope bytes=" + raw.length());
                return false;
            }
            if (!writePrimary(raw)) return false;
            cached = raw;
            loaded = true;
            final String mirror = raw;
            statsExecutor().execute(() -> mirrorExternal(mirror));
            return true;
        }

        synchronized boolean remove() {
            boolean ok = true;
            if (primary.exists() && !primary.delete()) ok = false;
            if (backup.exists() && !backup.delete()) ok = false;
            if (external != null && external.exists() && !external.delete()) ok = false;
            cached = null;
            loaded = true;
            Log.i(TAG, "[stats-store] removed ok=" + ok);
            return ok;
        }

        private boolean writePrimary(String raw) {
            if (primary.isFile()) {
                String previous = readText(primary);
                if (isEnvelope(previous)) writeAtomic(backup, previous);
            }
            boolean ok = writeAtomic(primary, raw);
            Log.i(TAG, "[stats-store] write bytes=" + raw.length() + " ok=" + ok);
            return ok;
        }

        private void mirrorExternal(String raw) {
            if (external == null) return;
            if (writeAtomic(external, raw)) {
                externalMirrorFailed = false;
            } else if (!externalMirrorFailed) {
                externalMirrorFailed = true;
                Log.w(TAG, "[stats-store] external mirror failed path=" + external.getAbsolutePath());
            }
        }

        private boolean writeAtomic(File file, String raw) {
            File tmp = new File(file.getParentFile(), file.getName() + ".tmp");
            OutputStream out = null;
            try {
                if (file.getParentFile() != null) file.getParentFile().mkdirs();
                out = new FileOutputStream(tmp);
                out.write(raw.getBytes(StandardCharsets.UTF_8));
                out.flush();
                ((FileOutputStream) out).getFD().sync();
                out.close();
                out = null;
                if (tmp.renameTo(file)) return true;
                if (file.exists()) file.delete();
                return tmp.renameTo(file);
            } catch (Exception e) {
                Log.w(TAG, "[stats-store] cannot write " + file.getName(), e);
                return false;
            } finally {
                if (out != null) try { out.close(); } catch (IOException ignored) { /* nothing to do */ }
                if (tmp.exists() && !file.exists()) tmp.delete();
            }
        }

        private void quarantine(File file) {
            try {
                File target = new File(getFilesDir(), "local-stats.damaged-" + System.currentTimeMillis() + ".json");
                if (file.renameTo(target)) Log.w(TAG, "[stats-store] quarantined " + target.getName());
            } catch (Exception e) {
                Log.w(TAG, "[stats-store] cannot quarantine", e);
            }
        }

        private boolean isEnvelope(String raw) {
            if (raw == null || raw.isEmpty()) return false;
            try {
                Object parsed = new org.json.JSONTokener(raw).nextValue();
                return parsed instanceof JSONObject && ((JSONObject) parsed).has("v")
                        && ((JSONObject) parsed).optJSONArray("records") != null;
            } catch (Exception e) {
                return false;
            }
        }

        private String readText(File file) {
            try { return new String(readAll(file), StandardCharsets.UTF_8); }
            catch (Exception e) { return ""; }
        }
    }

    /** Write an export to the public Downloads folder (API 29+, no storage permission). */
    private String saveStatsToDownloads(String name, String text) {
        Uri uri = null;
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Stronghold-Protocol");
            uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) return null;
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) return null;
                out.write(text.getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
            return displayPathOf(uri, name);
        } catch (Exception e) {
            Log.w(TAG, "[stats-file] MediaStore insert/write failed", e);
            if (uri != null) {
                try { getContentResolver().delete(uri, null, null); } catch (Exception ignored) { /* nothing to do */ }
            }
            return null;
        }
    }

    private String displayPathOf(Uri uri, String fallbackName) {
        String display = fallbackName;
        String relative = Environment.DIRECTORY_DOWNLOADS + "/Stronghold-Protocol";
        try (Cursor c = getContentResolver().query(uri,
                new String[]{OpenableColumns.DISPLAY_NAME, MediaStore.MediaColumns.RELATIVE_PATH}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int di = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int ri = c.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH);
                if (di >= 0 && !c.isNull(di)) display = c.getString(di);
                if (ri >= 0 && !c.isNull(ri)) relative = c.getString(ri);
            }
        } catch (Exception ignored) { /* fall back to the requested path */ }
        String rel = relative == null ? "" : relative;
        if (rel.startsWith("Download/")) rel = "下载/" + rel.substring("Download/".length());
        else if (rel.equals("Download") || rel.equals("Download/")) rel = "下载";
        if (rel.isEmpty()) rel = "下载";
        return (rel.endsWith("/") ? rel : rel + "/") + display;
    }

    private String displayNameOf(Uri uri, String fallback) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) { /* fall back */ }
        return fallback;
    }

    private static String sanitizeExportName(String input) {
        String name = input == null ? "" : input.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.isEmpty()) name = "stronghold-stats.json";
        if (name.length() > 120) name = name.substring(name.length() - 120);
        if (!name.toLowerCase(Locale.ROOT).endsWith(".json")) name = name + ".json";
        return name;
    }

    private void showExportResult(final String path) {
        runOnUiThread(() -> {
            if (isFinishing()) return;
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle("统计已导出")
                    .setMessage("已保存到：\n" + path)
                    .setPositiveButton("好", null)
                    .setNeutralButton("复制路径", (dialog, which) -> copyToClipboard("统计导出路径", path))
                    .show();
        });
    }

    private void copyToClipboard(String label, String text) {
        try {
            ClipboardManager manager = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            manager.setPrimaryClip(ClipData.newPlainText(label, text));
            Toast.makeText(this, "路径已复制", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Log.w(TAG, "[stats-file] cannot copy path", e);
        }
    }

    private final class LocalBridge {
        @JavascriptInterface
        public void openRemote(String url) {
            Log.i(TAG, "[art] openRemote url=" + url);
            if (!isAllowedRemoteUrl(url) || isAppLocalOrigin(originOfUrl(url))) return;
            remoteRequestedUrl = url;
            remoteFinalUrl = url;
            remoteGameOrigin = originOfUrl(url);
            remoteVerification = "compatible-unknown";
            remoteEntryRedirectPending = true;
            remoteArtMode = "local-first";
            remoteAssetMatch = false;
            applyArtTargets(null);
            runOnUiThread(() -> loadRemoteUrl(url));
        }

        @JavascriptInterface
        public boolean openRemoteWithArt(String url, String mode, boolean assetMatch, String targetsJson) {
            Log.i(TAG, "[art] openRemoteWithArt url=" + url + " mode=" + mode + " match=" + assetMatch + " targets=" + targetsJson);
            if (!isAllowedRemoteUrl(url)) return false;
            String finalUrl = url;
            String gameOrigin = null;
            String verification = null;
            try {
                JSONObject policy = new JSONObject(targetsJson == null ? "{}" : targetsJson);
                String candidateFinal = policy.optString("finalUrl", "");
                if (isAllowedRemoteUrl(candidateFinal)) finalUrl = candidateFinal;
                String candidateOrigin = policy.optString("gameOrigin", "");
                if (isAllowedRemoteUrl(candidateOrigin)) gameOrigin = originOfUrl(candidateOrigin);
                verification = policy.optString("verification", "");
                remoteCollectStats = policy.optBoolean("collectStats", true);
            } catch (Exception e) {
                Log.w(TAG, "[art] invalid remote policy", e);
            }
            if (!isAllowedRemoteUrl(finalUrl)) return false;
            if (isAppLocalOrigin(originOfUrl(url)) || isAppLocalOrigin(originOfUrl(finalUrl))
                    || isAppLocalOrigin(gameOrigin)) return false;
            remoteRequestedUrl = url;
            remoteFinalUrl = finalUrl;
            remoteGameOrigin = gameOrigin != null ? gameOrigin : originOfUrl(finalUrl);
            remoteVerification = verification == null || verification.isEmpty() ? "compatible-unknown" : verification;
            remoteEntryRedirectPending = true;
            remoteArtMode = "local-first".equals(mode) ? "local-first" : "strict";
            remoteAssetMatch = assetMatch;
            applyArtTargets(targetsJson);
            runOnUiThread(() -> loadRemoteUrl(url));
            return true;
        }

        @JavascriptInterface
        public boolean openExternal(String url) {
            if (!isAllowedRemoteUrl(url) || isAppLocalOrigin(originOfUrl(url))) return false;
            remoteRequestedUrl = url;
            remoteFinalUrl = url;
            remoteGameOrigin = originOfUrl(url);
            remoteVerification = "compatible-unknown";
            remoteEntryRedirectPending = true;
            remoteArtMode = "local-first";
            remoteAssetMatch = false;
            applyArtTargets(null);
            runOnUiThread(() -> loadRemoteUrl(url));
            return true;
        }

        @JavascriptInterface
        public String remoteCacheStats() {
            try {
                File dir = remotePackDir();
                JSONObject out = new JSONObject();
                out.put("packBytes", directorySize(dir));
                out.put("packFiles", countFiles(dir));
                out.put("session", "auto");
                out.put("mode", remoteArtMode);
                return out.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public int clearRemotePacks() {
            int removed = countFiles(remotePackDir());
            deleteTree(remotePackDir());
            Log.i(TAG, "[art] cleared L2 packs: " + removed);
            return removed;
        }

        @JavascriptInterface
        public int dedupeRemotePacks() {
            Map<String, ArtEntry> index = artIndex;
            if (index == null) { loadArtIndex(); return 0; }
            Set<String> localHashes = new HashSet<String>();
            for (ArtEntry entry : index.values()) {
                localHashes.add(entry.fileHash);
                localHashes.addAll(entry.modelHashes);
            }
            int removed = 0;
            File dir = remotePackDir();
            File[] files = dir.listFiles();
            if (files != null) {
                for (File file : files) {
                    if (!file.isFile()) continue;
                    String hash = sha256Prefix(file);
                    if (hash != null && localHashes.contains(hash) && file.delete()) removed++;
                }
            }
            Log.i(TAG, "[art] deduped L2 packs: " + removed);
            return removed;
        }

        @JavascriptInterface
        public boolean requestRemoteCacheClear() {
            pendingRemoteCacheClear = true;
            Log.i(TAG, "[art] remote page cache clear scheduled for the next connection");
            return true;
        }

        @JavascriptInterface
        public String readLocalStats() {
            if (!isLocalBridgeAllowed()) { Log.w(TAG, "[stats-store] bridge rejected read"); return null; }
            return statsStore.read();
        }

        @JavascriptInterface
        public boolean writeLocalStats(String raw) {
            if (!isLocalBridgeAllowed()) { Log.w(TAG, "[stats-store] bridge rejected write"); return false; }
            return statsStore.write(raw);
        }

        @JavascriptInterface
        public boolean removeLocalStats() {
            if (!isLocalBridgeAllowed()) { Log.w(TAG, "[stats-store] bridge rejected remove"); return false; }
            return statsStore.remove();
        }

        /** Save the statistics export through MediaStore (29+) or SAF; the page shows the returned path. */
        @JavascriptInterface
        public String exportStats(String filename, String text) {
            if (!isLocalBridgeAllowed()) { Log.w(TAG, "[stats-file] export rejected (not the local page)"); return "error"; }
            if (text == null || text.isEmpty() || text.length() > 8_000_000) {
                Log.w(TAG, "[stats-file] export invalid bytes=" + (text == null ? -1 : text.length()));
                return "error";
            }
            final String name = sanitizeExportName(filename);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    String saved = saveStatsToDownloads(name, text);
                    if (saved != null) {
                        showExportResult(saved);
                        Log.i(TAG, "[stats-file] export saved path=" + saved + " bytes=" + text.length());
                        return "saved:" + saved;
                    }
                    Log.w(TAG, "[stats-file] MediaStore unavailable; opening the save picker");
                }
                runOnUiThread(() -> {
                    pendingExportText = text;
                    pendingExportName = name;
                    try {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("application/json");
                        intent.putExtra(Intent.EXTRA_TITLE, name);
                        startActivityForResult(intent, REQ_STATS_EXPORT);
                        Log.i(TAG, "[stats-file] export picker opened name=" + name);
                    } catch (Exception e) {
                        pendingExportText = null;
                        pendingExportName = null;
                        Toast.makeText(MainActivity.this, "无法打开保存窗口", Toast.LENGTH_LONG).show();
                        Log.w(TAG, "[stats-file] cannot open save picker", e);
                    }
                });
                return "picker";
            } catch (Exception e) {
                Log.w(TAG, "[stats-file] export failed", e);
                return "error";
            }
        }
    }

    /** Store the allowlisted asset origins/prefixes; the entry origin itself never becomes an art source. */
    private void applyArtTargets(String json) {
        Set<String> origins = new HashSet<String>();
        Set<String> redirects = new HashSet<String>();
        List<String> prefixes = new ArrayList<String>();
        if (json != null && !json.isEmpty()) {
            try {
                JSONObject object = new JSONObject(json);
                for (String key : new String[]{"origins", "assetOrigins"}) {
                    JSONArray originList = object.optJSONArray(key);
                    if (originList == null) continue;
                    for (int i = 0; i < originList.length(); i++) {
                        String raw = originList.optString(i, "");
                        if (!isAllowedRemoteUrl(raw)) continue;
                        String origin = originOf(Uri.parse(raw));
                        if (origin != null) origins.add(origin);
                    }
                }
                String finalUrl = object.optString("finalUrl", "");
                if (isAllowedRemoteUrl(finalUrl)) {
                    String origin = originOf(Uri.parse(finalUrl));
                    if (origin != null) origins.add(origin);
                }
                String gameOrigin = object.optString("gameOrigin", "");
                if (isAllowedRemoteUrl(gameOrigin)) {
                    String origin = originOf(Uri.parse(gameOrigin));
                    if (origin != null) origins.add(origin);
                }
                JSONArray redirectList = object.optJSONArray("redirectOrigins");
                if (redirectList != null) {
                    for (int i = 0; i < redirectList.length(); i++) {
                        String raw = redirectList.optString(i, "");
                        if (!isAllowedRemoteUrl(raw)) continue;
                        String origin = originOf(Uri.parse(raw));
                        if (origin != null) redirects.add(origin);
                    }
                }
                JSONArray prefixList = object.optJSONArray("prefixes");
                if (prefixList != null) {
                    for (int i = 0; i < prefixList.length(); i++) {
                        String prefix = normalizeArtPrefix(prefixList.optString(i, ""));
                        if (prefix != null) prefixes.add(prefix);
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "[art] invalid asset targets from the page", e);
            }
        }
        if (prefixes.isEmpty()) prefixes.add("");
        remoteArtOrigins = Collections.unmodifiableSet(origins);
        remoteRedirectOrigins = Collections.unmodifiableSet(redirects);
        remoteArtPrefixes = Collections.unmodifiableList(prefixes);
        Log.i(TAG, "[art] targets origins=" + remoteArtOrigins + " prefixes=" + remoteArtPrefixes);
    }

    private static String normalizeArtPrefix(String value) {
        if (value == null || value.isEmpty() || "/".equals(value)) return "";
        if (!value.startsWith("/") || value.contains("\\") || value.contains("\0") || value.contains("..")) return null;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    private boolean isAllowedRemoteUrl(String value) {
        try {
            Uri uri = Uri.parse(value);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (host == null || uri.getUserInfo() != null || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) return false;
            String h = host.toLowerCase(java.util.Locale.ROOT).replaceAll("^\\[|\\]$", "");
            if (h.equals("localhost") || h.endsWith(".localhost") || h.equals("::1") || h.equals("::") || h.equals("0.0.0.0")) return false;
            if (h.matches("127(?:\\.[0-9]{1,3}){3}")) return false;
            if (h.startsWith("::ffff:")) {
                String mapped = h.substring(7);
                if (mapped.startsWith("127.")) return false;
                if (mapped.matches("[0-9a-f]{1,4}:[0-9a-f]{1,4}")) {
                    String[] pair = mapped.split(":");
                    if ((Integer.parseInt(pair[0], 16) >>> 8) == 0x7f) return false;
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Scheme + host + port, so an https default port and an explicit :443 compare equal. */
    private static String originOf(Uri uri) {
        if (uri == null) return null;
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) return null;
        int port = uri.getPort();
        if (port < 0) port = "https".equalsIgnoreCase(scheme) ? 443 : 80;
        return scheme.toLowerCase(Locale.ROOT) + "://" + host.toLowerCase(Locale.ROOT) + ":" + port;
    }

    private boolean isLocalPageUrl(String url) {
        if (localServerUrl == null || url == null) return false;
        String a = originOf(Uri.parse(url));
        String b = originOf(Uri.parse(localServerUrl));
        return a != null && a.equals(b);
    }

    private void loadArtIndex() {
        synchronized (artIndexLock) {
            if (artIndex != null || artIndexLoading || artIndexFailed) return;
            artIndexLoading = true;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                Map<String, ArtEntry> map = new HashMap<String, ArtEntry>();
                try (InputStream raw = getAssets().open(PROJECT + "/art-index.tsv");
                     BufferedReader reader = new BufferedReader(new InputStreamReader(raw, StandardCharsets.UTF_8))) {
                    String line;
                    int lineNo = 0;
                    while ((line = reader.readLine()) != null) {
                        lineNo++;
                        if (line.isEmpty() || line.charAt(0) == '#') continue;
                        String[] p = line.split("\t", -1);
                        if (p.length != 6) throw new IOException("bad art-index row " + lineNo);
                        String url = p[0], fileHash = p[1], modelText = p[2], sizeText = p[3], mime = p[4], assetPath = p[5];
                        if (!url.startsWith("/") || url.contains("..") || url.contains("\\") || url.contains("\0")
                                || !assetPath.startsWith("public/") || assetPath.contains("..") || assetPath.contains("\\")
                                || !fileHash.matches("[0-9a-f]{16}")) {
                            throw new IOException("unsafe art-index row " + lineNo);
                        }
                        Set<String> models = new HashSet<String>();
                        if (!"-".equals(modelText) && !modelText.isEmpty()) {
                            for (String h : modelText.split(",")) if (h.matches("[0-9a-f]{16}")) models.add(h);
                        }
                        long size = Long.parseLong(sizeText);
                        map.put(url, new ArtEntry(fileHash, Collections.unmodifiableSet(models), size, mime, assetPath));
                    }
                    if (map.isEmpty()) throw new IOException("empty art index");
                    artIndex = map;
                    Log.i(TAG, "[art] index loaded: " + map.size() + " URLs");
                } catch (Throwable t) {
                    artIndexFailed = true;
                    Log.e(TAG, "[art] index load failed; remote art will be used", t);
                } finally {
                    synchronized (artIndexLock) { artIndexLoading = false; }
                }
            }
        }, "sp-art-index").start();
    }

    /** Answer a subresource of the confirmed remote page from the APK; null lets WebView use the network. */
    private WebResourceResponse interceptLocalArt(WebResourceRequest request) {
        if (remoteArtOrigin == null || request == null || request.isForMainFrame()) return null;
        Uri uri = request.getUrl();
        if (uri == null) return null;
        if (isBlockedRemoteUri(uri)) {
            Log.w(TAG, "[art] blocked local/private request " + uri);
            return blockedResponse();
        }
        String method = request.getMethod();
        boolean preflight = "OPTIONS".equalsIgnoreCase(method)
                && headerValue(request, "Access-Control-Request-Method") != null;
        if (!"GET".equalsIgnoreCase(method) && !preflight) return null;
        String requestOrigin = originOf(uri);
        if (artSeen.incrementAndGet() <= 25) Log.i(TAG, "[art] seen " + uri + " origin=" + requestOrigin + " allowed=" + remoteArtOrigins.contains(requestOrigin));
        if (requestOrigin == null) return null;
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return null;
        String path = mapArtPath(decodeArtPath(uri.getEncodedPath()));
        if (path == null) {
            if (artSeen.get() <= 25) Log.i(TAG, "[art] unmapped " + uri + " prefixes=" + remoteArtPrefixes);
            return null;
        }
        String[] split = splitArtHash(path);
        path = split[0];
        String hash = split[1];
        Map<String, ArtEntry> index = artIndex;
        if (index == null) { loadArtIndex(); return null; }
        ArtEntry entry = index.get(path);
        if (entry == null && path.startsWith("/media/")) {
            String rest = path.substring("/media/".length());
            String stem = rest;
            int dot = stem.lastIndexOf('.');
            if (dot > 0) stem = stem.substring(0, dot);
            entry = index.get("/media/" + stem);
            if (entry == null) {
                for (String ext : new String[]{".mp3", ".ogg", ".wav", ".m4a", ".aac"}) {
                    entry = index.get("/assets/audio/" + rest + ext);
                    if (entry == null) entry = index.get("/assets/audio/" + stem + ext);
                    if (entry != null) break;
                }
            }
        }
        if (entry == null) { noteArtMiss(path, "no-local"); return null; }
        // A declared CDN may be undeclared on some builds: once the page has landed on its game
        // origin, an origin asking for a path that really exists in L0 becomes a material source.
        if (!remoteArtOrigins.contains(requestOrigin) && !remoteEntryRedirectPending) {
            Set<String> origins = new HashSet<String>(remoteArtOrigins);
            origins.add(requestOrigin);
            remoteArtOrigins = Collections.unmodifiableSet(origins);
            Log.i(TAG, "[art] dynamic asset origin " + requestOrigin);
        }
        if (!remoteArtOrigins.contains(requestOrigin)) return null;
        boolean local;
        if ("local-first".equals(remoteArtMode)) local = true;
        else if (hash != null) local = entry.fileHash.equals(hash) || entry.modelHashes.contains(hash);
        else local = remoteAssetMatch;
        if (!local) { noteArtMiss(path, hash != null ? "hash-mismatch" : "manifest-mismatch"); return null; }

        if (preflight) return preflightResponse(request);
        String range = headerValue(request, "Range");
        if (range != null) return serveArtRange(entry, range, hash);
        InputStream stream;
        try {
            stream = getAssets().open(PROJECT + "/" + entry.assetPath);
        } catch (IOException e) {
            noteArtMiss(path, "open-failed");
            return null;
        }
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Content-Length", String.valueOf(entry.size));
        headers.put("Cache-Control", cachePolicy(hash, entry));
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("X-SP-Art-Source", "local");
        addCorsHeaders(headers);
        noteArtHit(path);
        return new WebResourceResponse(entry.mime, null, 200, "OK", headers, stream);
    }

    private WebResourceResponse serveArtRange(ArtEntry entry, String rangeHeader, String hash) {
        long[] range = parseRange(rangeHeader, entry.size);
        if (range == null) return null;
        AssetFileDescriptor afd = null;
        FileInputStream fis = null;
        try {
            afd = getAssets().openFd(PROJECT + "/" + entry.assetPath);
            fis = new FileInputStream(afd.getFileDescriptor());
            long skip = afd.getStartOffset() + range[0];
            while (skip > 0) {
                long n = fis.skip(skip);
                if (n <= 0) break;
                skip -= n;
            }
            long length = range[1] - range[0] + 1;
            Map<String, String> headers = new HashMap<String, String>();
            headers.put("Content-Length", String.valueOf(length));
            headers.put("Content-Range", "bytes " + range[0] + "-" + range[1] + "/" + entry.size);
            headers.put("Accept-Ranges", "bytes");
            headers.put("Cache-Control", cachePolicy(hash, entry));
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("X-SP-Art-Source", "local");
            addCorsHeaders(headers);
            noteArtHit(entry.assetPath);
            return new WebResourceResponse(entry.mime, null, 206, "Partial Content", headers,
                    new LimitedInputStream(fis, length, afd));
        } catch (IOException e) {
            if (fis != null) try { fis.close(); } catch (IOException ignored) { }
            if (afd != null) try { afd.close(); } catch (IOException ignored) { }
            return null;
        }
    }

    /** The page reads L0 art cross-origin (CORS fetches, crossOrigin textures); intercepted answers must carry CORS. */
    private static void addCorsHeaders(Map<String, String> headers) {
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Expose-Headers",
                "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified");
        headers.put("Cross-Origin-Resource-Policy", "cross-origin");
        headers.put("Timing-Allow-Origin", "*");
    }

    private WebResourceResponse preflightResponse(WebResourceRequest request) {
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        String requestedHeaders = headerValue(request, "Access-Control-Request-Headers");
        headers.put("Access-Control-Allow-Headers",
                requestedHeaders != null ? requestedHeaders : "Range, Content-Type");
        headers.put("Access-Control-Max-Age", "86400");
        return new WebResourceResponse("text/plain", "utf-8", 204, "No Content", headers,
                new ByteArrayInputStream(new byte[0]));
    }

    /** L0 is served straight from the APK; no-store keeps the browser from copying it into L1/L2. */
    private static String cachePolicy(String hash, ArtEntry entry) {
        return "no-store";
    }

    private static String decodeArtPath(String encoded) {
        if (encoded == null || encoded.isEmpty()) return null;
        String path = Uri.decode(encoded);
        if (path.isEmpty() || path.charAt(0) != '/' || path.contains("\\") || path.contains("%")
                || path.contains("\0") || path.contains("//")) return null;
        for (String segment : path.split("/", -1)) {
            if (".".equals(segment) || "..".equals(segment)) return null;
        }
        return path;
    }

    /** Strip any host/page prefix, returning the canonical /assets/... path used by the APK index. */
    private String mapArtPath(String fullPath) {
        if (fullPath == null) return null;
        String[] roots = new String[]{"/assets/", "/fonts/", "/media/", "/icons/"};
        for (String prefix : remoteArtPrefixes) {
            String base = prefix == null ? "" : prefix;
            for (String root : roots) {
                String needle = base + root;
                if (fullPath.startsWith(needle)) return root + fullPath.substring(needle.length());
            }
        }
        // The server may mount the game (and its art) below a path the manifests do not declare.
        for (String root : roots) {
            int at = fullPath.indexOf(root);
            if (at >= 0) return root + fullPath.substring(at + root.length());
        }
        return null;
    }

    /** '/assets/~0123456789abcdef/x.png' → { '/assets/x.png', '0123456789abcdef' }; non-hashed paths keep null. */
    private static String[] splitArtHash(String path) {
        for (String root : new String[]{"/assets/", "/fonts/", "/media/", "/icons/"}) {
            if (!path.startsWith(root)) continue;
            int slash = path.indexOf('/', root.length());
            if (slash < 0) break;
            String segment = path.substring(root.length(), slash);
            if (segment.matches("~[0-9a-f]{16}")) {
                return new String[]{root + path.substring(slash + 1), segment.substring(1)};
            }
            break;
        }
        return new String[]{path, null};
    }

    private static String headerValue(WebResourceRequest request, String name) {
        for (Map.Entry<String, String> e : request.getRequestHeaders().entrySet()) {
            if (name.equalsIgnoreCase(e.getKey())) return e.getValue();
        }
        return null;
    }

    private static long[] parseRange(String value, long size) {
        if (value == null || size <= 0) return null;
        String text = value.trim();
        if (!text.startsWith("bytes=")) return null;
        text = text.substring(6).trim();
        if (text.contains(",")) return null;
        int dash = text.indexOf('-');
        if (dash < 0) return null;
        String a = text.substring(0, dash).trim();
        String b = text.substring(dash + 1).trim();
        long start;
        long end;
        try {
            if (a.isEmpty()) {
                long suffix = Long.parseLong(b);
                if (suffix <= 0) return null;
                start = Math.max(0, size - suffix);
                end = size - 1;
            } else {
                start = Long.parseLong(a);
                end = b.isEmpty() ? size - 1 : Long.parseLong(b);
            }
        } catch (NumberFormatException e) {
            return null;
        }
        if (start < 0 || start >= size || end < start) return null;
        if (end >= size) end = size - 1;
        return new long[]{start, end};
    }

    private void noteArtHit(String path) {
        int n = artHits.incrementAndGet();
        if (n <= 20 || n % 200 == 0) Log.i(TAG, "[art] hit " + path + " (" + remoteArtMode + ")");
    }

    private void noteArtMiss(String path, String reason) {
        int n = artMisses.incrementAndGet();
        if (n <= 20 || n % 200 == 0) Log.i(TAG, "[art] miss " + path + " (" + reason + ", " + remoteArtMode + ")");
    }

    private boolean isRemoteSession() {
        return remoteFinalUrl != null || remoteRequestedUrl != null;
    }

    private void resetRemotePolicy() {
        remoteRequestedUrl = null;
        remoteFinalUrl = null;
        remoteGameOrigin = null;
        remoteVerification = null;
        remoteRedirectOrigins = Collections.emptySet();
        remoteEntryRedirectPending = false;
        remoteArtOrigin = null;
        remoteArtOrigins = Collections.emptySet();
        remoteArtPrefixes = Collections.emptyList();
        remoteServerConfirmed = false;
        remoteCheckToken = null;
        remoteAppVersion = "";
        stopStatsBackstop();
    }

    private static String originOfUrl(String value) {
        if (value == null) return null;
        try { return originOf(Uri.parse(value)); } catch (Exception e) { return null; }
    }

    private void rememberRemoteOrigin(String origin) {
        if (origin == null || isBlockedRemoteOrigin(origin) || remoteArtOrigins.contains(origin)) return;
        Set<String> origins = new HashSet<String>(remoteArtOrigins);
        origins.add(origin);
        remoteArtOrigins = Collections.unmodifiableSet(origins);
    }

    private boolean isBlockedRemoteOrigin(String origin) {
        if (origin == null) return true;
        try { return isBlockedRemoteUri(Uri.parse(origin)); } catch (Exception e) { return true; }
    }

    private static boolean isPrivateHost(String host) {
        String h = host == null ? "" : host.toLowerCase(Locale.ROOT).replaceAll("^\\[|\\]$", "");
        if (h.isEmpty()) return true;
        if (h.equals("localhost") || h.endsWith(".localhost") || h.equals("::1") || h.equals("::") || h.equals("0.0.0.0")) return true;
        if (h.matches("127(?:\\.[0-9]{1,3}){3}")) return true;
        if (h.matches("10(?:\\.[0-9]{1,3}){3}")) return true;
        if (h.matches("192\\.168(?:\\.[0-9]{1,3}){2}")) return true;
        if (h.matches("172\\.(?:1[6-9]|2\\d|3[01])(?:\\.[0-9]{1,3}){2}")) return true;
        if (h.matches("169\\.254(?:\\.[0-9]{1,3}){2}")) return true;
        if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;
        return false;
    }

    /** Loopback, the app's own server and private hosts other than the admitted game/asset origins. */
    private boolean isBlockedRemoteUri(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return true;
        String host = uri.getHost();
        if (host == null) return true;
        String origin = originOf(uri);
        if (origin == null) return true;
        if (isAppLocalOrigin(origin)) return true;
        if (isPrivateHost(host)) {
            return !origin.equals(remoteGameOrigin) && !remoteArtOrigins.contains(origin);
        }
        return false;
    }

    private boolean isAppLocalOrigin(String origin) {
        if (origin == null) return false;
        if (origin.equals(originOfUrl(localServerUrl))) return true;
        try {
            String host = Uri.parse(origin).getHost();
            if (host == null) return false;
            String h = host.toLowerCase(Locale.ROOT).replaceAll("^\\[|\\]$", "");
            if (h.equals("localhost") || h.equals("::1") || h.equals("::") || h.equals("0.0.0.0")
                    || h.matches("127(?:\\.[0-9]{1,3}){3}")) return true;
        } catch (Exception e) { return false; }
        if (handshake != null) {
            JSONArray lan = handshake.optJSONArray("lan");
            if (lan != null) {
                for (int i = 0; i < lan.length(); i++) {
                    if (origin.equals(originOfUrl(lan.optString(i, "")))) return true;
                }
            }
        }
        return false;
    }

    private boolean allowRemoteNavigation(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return false;
        String origin = originOf(uri);
        if (origin == null) return false;
        if (isAppLocalOrigin(origin)) return false;
        // The one-shot entry navigation may start on a public join service or a LAN address the
        // player typed, but never on this app's own server.
        if (remoteEntryRedirectPending && (origin.equals(originOfUrl(remoteRequestedUrl))
                || remoteRedirectOrigins.contains(origin))) return true;
        if (isBlockedRemoteUri(uri)) return false;
        String game = remoteGameOrigin;
        String finalOrigin = originOfUrl(remoteFinalUrl);
        return origin.equals(game) || origin.equals(finalOrigin);
    }

    private boolean allowRemoteSubframe(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return false;
        if (isBlockedRemoteUri(uri)) return false;
        String origin = originOf(uri);
        if (origin == null) return false;
        return origin.equals(remoteGameOrigin) || origin.equals(originOfUrl(remoteFinalUrl)) || remoteArtOrigins.contains(origin);
    }

    private volatile boolean remoteBlockDialogShowing = false;

    private void blockRemoteNavigation(String url) {
        blockRemoteNavigation(url, true);
    }

    private void blockRemoteNavigation(String url, boolean mainFrame) {
        Log.w(TAG, "[remote] blocked " + (mainFrame ? "navigation " : "subframe ") + url);
        if (!mainFrame) return;
        if (web != null) web.stopLoading();
        if (remoteBlockDialogShowing) return;
        remoteBlockDialogShowing = true;
        ui.post(() -> {
            if (isFinishing()) { remoteBlockDialogShowing = false; return; }
            new AlertDialog.Builder(this)
                    .setTitle("已阻止远程页面跳转")
                    .setMessage("远程页面尝试打开不允许的地址（本机服务、回环/私有网络或非游戏站点）。\n\n" + url)
                    .setPositiveButton("返回本地入口", (dialog, which) -> {
                        remoteBlockDialogShowing = false;
                        returnToLocalTitle();
                    })
                    .setNegativeButton("留在此页", (dialog, which) -> remoteBlockDialogShowing = false)
                    .setOnCancelListener(dialog -> remoteBlockDialogShowing = false)
                    .show();
        });
    }

    private WebResourceResponse blockedResponse() {
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private void clearRemotePageCachesOnce() {
        if (web == null) return;
        String script = "(async()=>{try{const k='sp.remote.cacheCleared';"
                + "if(sessionStorage.getItem(k))return;sessionStorage.setItem(k,'1');"
                + "const rs=await navigator.serviceWorker.getRegistrations();"
                + "await Promise.all(rs.map(r=>r.unregister()));"
                + "const ks=await caches.keys();await Promise.all(ks.map(x=>caches.delete(x)));"
                + "location.reload();}catch(e){}})()";
        web.evaluateJavascript(script, null);
        Log.i(TAG, "[art] remote page caches will be cleared once");
    }

    private File remotePackDir() {
        return new File(getFilesDir(), "remote-packs");
    }

    private static long directorySize(File dir) {
        if (dir == null || !dir.isDirectory()) return 0;
        long total = 0;
        File[] files = dir.listFiles();
        if (files == null) return 0;
        for (File file : files) total += file.isDirectory() ? directorySize(file) : file.length();
        return total;
    }

    private static int countFiles(File dir) {
        if (dir == null || !dir.isDirectory()) return 0;
        int total = 0;
        File[] files = dir.listFiles();
        if (files == null) return 0;
        for (File file : files) total += file.isDirectory() ? countFiles(file) : 1;
        return total;
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        if (file.isFile()) file.delete(); else file.delete();
    }

    private static String sha256Prefix(File file) {
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) > 0) digest.update(buffer, 0, n);
            byte[] bytes = digest.digest();
            char[] hex = "0123456789abcdef".toCharArray();
            StringBuilder out = new StringBuilder(16);
            for (int i = 0; i < 8; i++) {
                int value = bytes[i] & 0xff;
                out.append(hex[value >>> 4]).append(hex[value & 0x0f]);
            }
            return out.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private void loadRemoteUrl(String url) {
        if (!isAllowedRemoteUrl(url)) {
            Log.w(TAG, "rejected invalid remote URL");
            return;
        }
        remoteServerConfirmed = false;
        if (remoteFinalUrl == null) {
            remoteRequestedUrl = url;
            remoteFinalUrl = url;
            remoteGameOrigin = originOfUrl(url);
            remoteVerification = "compatible-unknown";
            remoteEntryRedirectPending = true;
        }
        // The entry/origin in the address bar is deliberately not an art source; only the admitted
        // final/game origin (applyArtTargets) may answer /assets|fonts|media|icons from the APK.
        remoteArtOrigin = originOf(Uri.parse(url));
        String finalOrigin = originOfUrl(remoteFinalUrl);
        if (finalOrigin != null && (remoteGameOrigin == null || finalOrigin.equals(remoteGameOrigin))) {
            Set<String> origins = new HashSet<String>(remoteArtOrigins);
            origins.add(finalOrigin);
            remoteArtOrigins = Collections.unmodifiableSet(origins);
        }
        if (remoteArtPrefixes.isEmpty()) remoteArtPrefixes = Collections.singletonList("");
        loadArtIndex();
        disableLocalPreferences();
        preferencePage = url;
        web.removeJavascriptInterface("SP_BRIDGE");
        overlay.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(url);
        Log.i(TAG, "opening remote page " + Uri.parse(url).getHost());
    }

    private void showCertificateConfirmation(SslErrorHandler handler, SslError error) {
        runOnUiThread(() -> {
            if (isFinishing()) return;
            if (sslDialog != null && sslDialog.isShowing()) { handler.cancel(); return; }
            String url = error == null ? web.getUrl() : error.getUrl();
            String problem = error == null ? "证书验证失败" : error.getPrimaryError() + "：" + error;
            sslDialog = new AlertDialog.Builder(MainActivity.this)
                    .setTitle("链接证书需要确认")
                    .setMessage("该 HTTPS 证书无法通过系统验证，无法确认服务器身份。\n\n" + url
                            + "\n\n仅在你信任此地址和证书来源时继续。此选择只适用于当前证书请求，不会关闭全局证书校验。\n\n" + problem)
                    .setPositiveButton("仅本次继续", (dialog, which) -> handler.proceed())
                    .setNegativeButton("返回本机", (dialog, which) -> {
                        handler.cancel();
                        returnToLocalTitle();
                    })
                    .setOnCancelListener(dialog -> {
                        handler.cancel();
                        returnToLocalTitle();
                    })
                    .create();
            sslDialog.setCancelable(false);
            sslDialog.show();
        });
    }

    private void returnToLocalTitle() {
        final boolean wasRemote = isRemoteSession();
        final Runnable teardown = new Runnable() {
            @Override
            public void run() {
                resetRemotePolicy();
                remoteBlockDialogShowing = false;
                if (wasRemote && web != null) {
                    // Session end: drop the browser HTTP cache (L1). The server's own Cache Storage (L2)
                    // is preserved; clearing it is an explicit user action in Settings.
                    web.clearCache(true);
                    Log.i(TAG, "[art] remote session ended; browser cache cleared, L2 preserved");
                }
                if (localServerUrl != null) {
                    try { web.addJavascriptInterface(new LocalBridge(), "SP_BRIDGE"); }
                    catch (Throwable t) { Log.w(TAG, "cannot re-add local bridge", t); }
                    preferencePage = localServerUrl;
                    enableLocalPreferences(localServerUrl);
                    web.loadUrl(localServerUrl);
                }
            }
        };
        if (wasRemote && remoteCollectStats) {
            stopStatsBackstop();
            statsExecutor().execute(() -> runStatsPull("session-end"));
            new Handler(Looper.getMainLooper()).postDelayed(teardown, 1500);
            return;
        }
        teardown.run();
    }

    private void inspectRemoteGamePage(String pageUrl) {
        if (!isAllowedRemoteUrl(pageUrl) || remoteServerConfirmed || localServerUrl == null) return;
        String localHost = Uri.parse(localServerUrl).getHost();
        String pageHost = Uri.parse(pageUrl).getHost();
        if (pageHost == null || pageHost.equalsIgnoreCase(localHost)) return;
        final String token = UUID.randomUUID().toString();
        remoteCheckToken = token;
        String script = "(async()=>{try{" +
                "const until=Date.now()+10000;" +
                "while(Date.now()<until){" +
                "const title=!!document.querySelector('.title-screen');" +
                "if(title){const r=await fetch('/healthz',{cache:'no-store'});" +
                "if(r.ok){const h=await r.json();" +
                "if(h&&h.ok===true&&typeof h.app==='string'&&Number.isInteger(h.protocol)){" +
                "location.href='sp-remote-ready://confirm/" + token + "?url='+encodeURIComponent(location.href)" +
                "+'&app='+encodeURIComponent(h.app||'');return;}}}" +
                "await new Promise(resolve=>setTimeout(resolve,500));}" +
                "}catch(e){}})()";
        web.evaluateJavascript(script, null);
    }

    private boolean handleInternalRemoteCallback(WebView view, Uri uri) {
        if (!"sp-remote-ready".equals(uri.getScheme())) return false;
        String token = uri.getLastPathSegment();
        String pageUrl = uri.getQueryParameter("url");
        if (remoteCheckToken != null && remoteCheckToken.equals(token) && isAllowedRemoteUrl(pageUrl)) {
            String currentHost = Uri.parse(view.getUrl()).getHost();
            String targetHost = Uri.parse(pageUrl).getHost();
            String localHost = localServerUrl == null ? null : Uri.parse(localServerUrl).getHost();
            if (currentHost != null && targetHost != null && localHost != null
                    && currentHost.equalsIgnoreCase(targetHost) && !targetHost.equalsIgnoreCase(localHost)) {
                remoteCheckToken = null;
                remoteServerConfirmed = true;
                String app = uri.getQueryParameter("app");
                remoteAppVersion = app == null ? "" : app;
                Log.i(TAG, "remote game title and health endpoint confirmed; local server stays available");
            }
        }
        return true;
    }

    // -----------------------------------------------------------------------------------------------
    // remote match-record collection: observe the remote page's own stats writes, pull the diff,
    // archive it through the local server's /connect/records route
    // -----------------------------------------------------------------------------------------------

    /** Wrap the remote page's localStorage.setItem so a `sp.pref.stats` write reports itself over console. */
    private void installRemoteStatsHook(String pageUrl) {
        if (!remoteCollectStats || web == null) {
            Log.i(TAG, "[stats] hook skip collect=" + remoteCollectStats + " web=" + (web != null));
            return;
        }
        String origin = originOfUrl(pageUrl);
        if (origin == null || !origin.equals(remoteGameOrigin)) {
            Log.i(TAG, "[stats] hook skip origin=" + origin + " game=" + remoteGameOrigin);
            return;
        }
        Log.i(TAG, "[stats] hook installed origin=" + origin);
        String script = "(function(){if(window.__spStatsHook)return;window.__spStatsHook=1;" +
                "var pending=0;var orig=Storage.prototype.setItem;" +
                "Storage.prototype.setItem=function(k,v){orig.call(this,k,v);" +
                "if(this===window.localStorage&&k==='sp.pref.stats'){" +
                "if(pending)clearTimeout(pending);" +
                "pending=setTimeout(function(){pending=0;console.log('[sp-stats-dirty]');},1500);}};" +
                "})()";
        web.evaluateJavascript(script, null);
        scheduleStatsPull("sweep", 3000);
        startStatsBackstop();
    }

    private ScheduledExecutorService statsExecutor() {
        synchronized (statsExecLock) {
            if (statsExec == null || statsExec.isShutdown()) {
                statsExec = Executors.newSingleThreadScheduledExecutor(new java.util.concurrent.ThreadFactory() {
                    @Override
                    public Thread newThread(Runnable r) {
                        Thread t = new Thread(r, "sp-stats");
                        t.setDaemon(true);
                        return t;
                    }
                });
            }
            return statsExec;
        }
    }

    private void scheduleStatsPull(final String reason, long delayMs) {
        if (!remoteCollectStats) return;
        statsExecutor().schedule(new Runnable() {
            @Override
            public void run() { runStatsPull(reason); }
        }, delayMs, TimeUnit.MILLISECONDS);
    }

    private void startStatsBackstop() {
        synchronized (statsExecLock) {
            if (statsBackstop != null) return;
            statsBackstop = statsExecutor().scheduleWithFixedDelay(new Runnable() {
                @Override
                public void run() { runStatsPull("backstop"); }
            }, 120, 120, TimeUnit.SECONDS);
        }
    }

    private void stopStatsBackstop() {
        synchronized (statsExecLock) {
            if (statsBackstop != null) {
                statsBackstop.cancel(false);
                statsBackstop = null;
            }
        }
    }

    /** Pull unseen records from the remote page and archive them via the local server. Background thread only. */
    private void runStatsPull(String reason) {
        final String origin = remoteGameOrigin;
        if (origin == null || localServerUrl == null || !remoteCollectStats) {
            Log.i(TAG, "[stats] pull " + reason + " skip origin=" + origin + " local=" + (localServerUrl != null)
                    + " collect=" + remoteCollectStats);
            return;
        }
        Log.i(TAG, "[stats] pull " + reason + " start origin=" + origin);
        try {
            JSONObject tokenBody = new JSONObject(httpGetText(localServerUrl + "connect/token", null));
            final String control = tokenBody.optString("token", "");
            if (control.isEmpty()) {
                Log.w(TAG, "[stats] pull " + reason + ": no control token");
                return;
            }
            JSONObject idsBody = new JSONObject(httpGetText(
                    localServerUrl + "connect/records?ids=1&origin=" + Uri.encode(origin), control));
            JSONArray known = idsBody.optJSONArray("ids");
            List<String> knownIds = new ArrayList<String>();
            if (known != null) for (int i = 0; i < known.length(); i++) knownIds.add(known.getString(i));
            int total = 0;
            for (int round = 0; round < 10; round++) {
                JSONArray batch = new JSONArray();
                for (String id : knownIds) batch.put(id);
                String payload = pullStatsFromPage(origin, batch.toString());
                if (payload == null) break;
                JSONObject pulled = new JSONObject(payload);
                JSONArray records = pulled.optJSONArray("records");
                int n = records == null ? 0 : records.length();
                if (n > 0) {
                    JSONObject body = new JSONObject();
                    body.put("origin", origin);
                    body.put("host", Uri.parse(origin).getHost());
                    body.put("app", remoteAppVersion);
                    body.put("verification", remoteVerification == null ? "" : remoteVerification);
                    body.put("records", records);
                    httpPostJson(localServerUrl + "connect/records", control, body.toString());
                    for (int i = 0; i < n; i++) knownIds.add(records.getJSONObject(i).optString("id"));
                }
                total += n;
                if (n < 50) break;
            }
            Log.i(TAG, "[stats] pull " + reason + " origin=" + origin + " n=" + total);
        } catch (Exception e) {
            Log.w(TAG, "[stats] pull " + reason + " failed", e);
        }
    }

    /** Read unseen records out of the remote page; shows the sync banner while the pull is in flight. */
    private String pullStatsFromPage(String origin, String knownJson) throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        final String[] out = new String[1];
        // The page's location.origin omits default ports; our Uri-derived origin keeps them.
        final String pageOrigin = origin.replaceAll(":(?:443|80)$", "");
        String script = "(function(origin,known){" +
                "if(location.origin!==origin)return JSON.stringify({records:[]});" +
                "var banner=null;var timer=setTimeout(function(){" +
                "banner=document.createElement('div');banner.id='sp-sync-banner';" +
                "banner.textContent='正在同步服务器对战数据，期间请不要关闭游戏';" +
                "banner.setAttribute('style','position:fixed;left:50%;top:8%;transform:translateX(-50%);" +
                "z-index:2147483000;padding:10px 18px;background:rgba(6,12,10,0.92);border:1px solid #46e0b6;" +
                "color:#e8fff8;font:14px/1.4 ui-monospace,monospace;letter-spacing:0.08em;border-radius:2px;" +
                "pointer-events:none;white-space:nowrap;');" +
                "document.documentElement.appendChild(banner);},500);" +
                "function done(value){clearTimeout(timer);var b=document.getElementById('sp-sync-banner');" +
                "if(b)b.remove();return value;}" +
                "try{var raw=window.localStorage.getItem('sp.pref.stats');" +
                "if(!raw)return done(JSON.stringify({records:[]}));" +
                "var env=JSON.parse(raw);var seen={};known.forEach(function(k){seen[k]=1;});" +
                "var recs=(env.records||[]).filter(function(r){return r&&r.id&&!seen[r.id];}).slice(-50);" +
                "return done(JSON.stringify({v:env.v,records:recs}));" +
                "}catch(e){return done(JSON.stringify({records:[],error:String(e)}));}}" +
                ")(" + JSONObject.quote(pageOrigin) + "," + knownJson + ")";
        final String finalScript = script;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web == null) {
                    latch.countDown();
                    return;
                }
                web.evaluateJavascript(finalScript, new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        out[0] = value;
                        latch.countDown();
                    }
                });
            }
        });
        if (!latch.await(15, TimeUnit.SECONDS)) {
            Log.w(TAG, "[stats] pull page-timeout origin=" + origin);
            return null;
        }
        if (out[0] == null) return null;
        Object decoded = new org.json.JSONTokener(out[0]).nextValue();
        if (!(decoded instanceof String)) {
            Log.w(TAG, "[stats] pull page-error origin=" + origin + " value=" + String.valueOf(out[0]).substring(0, Math.min(200, out[0].length())));
            return null;
        }
        return (String) decoded;
    }

    private String httpGetText(String url, String control) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(15000);
        if (control != null) c.setRequestProperty("x-sp-control", control);
        try {
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            return sb.toString();
        } finally {
            c.disconnect();
        }
    }

    private void httpPostJson(String url, String control, String body) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(30000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        if (control != null) c.setRequestProperty("x-sp-control", control);
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        c.setFixedLengthStreamingMode(payload.length);
        OutputStream os = c.getOutputStream();
        os.write(payload);
        os.close();
        int code = c.getResponseCode();
        c.disconnect();
        if (code < 200 || code >= 300) throw new IOException("HTTP " + code);
    }

    private void stopNodeProcess(String reason) {
        final Process process = sNodeProcess;
        if (process == null) {
            sServerStarted = false;
            return;
        }
        if (sStopping) return;
        sStopping = true;
        Log.i(TAG, "stopping bundled Node process: " + reason);
        new Thread(() -> {
            process.destroy();
            try {
                if (!process.waitFor(3500, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                    Log.w(TAG, "Node did not stop after SIGTERM; forcing process exit");
                    process.destroyForcibly();
                    process.waitFor(1500, java.util.concurrent.TimeUnit.MILLISECONDS);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            } finally {
                if (sNodeProcess == process) sNodeProcess = null;
                sStopping = false;
                sServerStarted = false;
            }
        }, "sp-node-stop").start();
    }

    // -----------------------------------------------------------------------------------------------
    // start-up pipeline
    // -----------------------------------------------------------------------------------------------

    private void startEverything() {
        if (sServerStarted) {
            if (!processAlive(sNodeProcess)) {
                sServerStarted = false;
                sNodeProcess = null;
            } else {
                if (handshake == null) handshake = readHandshakeFile();
                if (handshake != null && handshake.optString("url", null) != null) {
                    localServerUrl = handshake.optString("url");
                    loadUrl(localServerUrl);
                } else {
                    setStatus("服务器已在运行…", "正在等待本机服务器");
                    new Thread(() -> watchHandshake(new File(getFilesDir(), "handshake.json")), "sp-watch").start();
                }
                return;
            }
        }
        sStopping = false;
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

    private JSONObject readHandshakeFile() {
        try {
            File file = new File(getFilesDir(), "handshake.json");
            if (file.isFile()) return new JSONObject(new String(readAll(file), StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "cannot recover server handshake: " + e.getMessage());
        }
        return null;
    }

    private static boolean processAlive(Process process) {
        if (process == null) return false;
        try {
            process.exitValue();
            return false;
        } catch (IllegalThreadStateException e) {
            return true;
        }
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
        return changed;
    }

    private void markApkUpdated() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putLong(K_LAST_UPDATE, pi.lastUpdateTime)
                    .putString(K_VERSION, pi.versionName == null ? "" : pi.versionName)
                    .apply();
        } catch (Exception e) {
            Log.w(TAG, "package info unavailable while marking update", e);
        }
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

            // The 0.3.x server imports runtime parsers from tools/assets. Keep
            // tools with the code tree so APK updates extract it alongside
            // server/plugins instead of leaving a build-valid but unusable
            // Node project on disk.
            String[] parts = { "server", "shared", "data", "docs", "mobile", "node_modules", "tools" };
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
            markApkUpdated();
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
        sStopping = false;
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
        nodeArgs.add(getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(K_OPEN_LAN, false) ? "0.0.0.0" : "127.0.0.1");
        nodeArgs.add("--port");
        int preferredPort = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("localPort", 3000);
        nodeArgs.add(String.valueOf(preferredPort >= 3000 && preferredPort <= 3009 ? preferredPort : 3000));

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
                    if (!sStopping && !isFinishing()) {
                        showError("本机服务器已停止", "Node.js 退出码 " + (exit == null ? "?" : exit)
                                + "；请退出后重新打开应用（日志：adb logcat -s StrongholdProtocol）", "退出", new Runnable() {
                            @Override
                            public void run() {
                                finish();
                            }
                        });
                    }
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
        File externalFiles = getExternalFilesDir(null);
        env.put("SP_EXTERNAL_FILES", externalFiles == null ? "" : externalFiles.getAbsolutePath());
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
        sNodeProcess = proc;
        final Process running = proc;
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
        } finally {
            if (sNodeProcess == proc) {
                sNodeProcess = null;
                sServerStarted = false;
            }
        }
    }

    private String networkLabel() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(K_OPEN_LAN, false)
                ? "局域网访问：开启（点击关闭）" : "局域网访问：关闭（点击开启）";
    }

    private JSONObject readValidHandshake(File file) {
        if (!file.isFile()) return null;
        try {
            JSONObject json = new JSONObject(new String(readAll(file), StandardCharsets.UTF_8));
            String url = json.optString("url", "");
            Uri parsed = Uri.parse(url);
            int port = json.optInt("port", -1);
            if (!"http".equals(parsed.getScheme()) || !"127.0.0.1".equals(parsed.getHost())
                    || port < 3000 || port > 3009 || parsed.getPort() != port
                    || json.optInt("health", 0) != 200 || !json.optBoolean("ws", false)) return null;
            return json;
        } catch (Exception e) {
            Log.w(TAG, "invalid existing handshake", e);
            return null;
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
                        if (readValidHandshake(file) == null) throw new IOException("Invalid server handshake");
                        handshake = json;
                        int boundPort = json.optInt("port", 3000);
                        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt("localPort", boundPort).apply();
                        localServerUrl = url;
                        String lan = lanList(json.optJSONArray("lan"));
                        Log.i(TAG, "server ready on " + url + (lan.length() == 0 ? "" : "  lan=" + lan) + "  node=" + json.optString("node", "?"));
                        setStatus("服务器已就绪，正在打开游戏…", lan.length() == 0 ? "正在加载客户端" : "局域网地址：" + lan);
                        loadUrl(url);
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

    /** One row of art-index.tsv: packaged bytes for a URL, with the hashes the server puts in URLs. */
    private static final class ArtEntry {
        final String fileHash;
        final Set<String> modelHashes;
        final long size;
        final String mime;
        final String assetPath;

        ArtEntry(String fileHash, Set<String> modelHashes, long size, String mime, String assetPath) {
            this.fileHash = fileHash;
            this.modelHashes = modelHashes;
            this.size = size;
            this.mime = mime;
            this.assetPath = assetPath;
        }
    }

    /** A range of an AssetFileDescriptor; closing the response also closes the descriptor. */
    private static final class LimitedInputStream extends FilterInputStream {
        private long remaining;
        private final AssetFileDescriptor afd;

        LimitedInputStream(InputStream in, long limit, AssetFileDescriptor afd) {
            super(in);
            this.remaining = limit;
            this.afd = afd;
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) return -1;
            int b = super.read();
            if (b >= 0) remaining--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (remaining <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, remaining));
            if (n > 0) remaining -= n;
            return n;
        }

        @Override
        public long skip(long n) throws IOException {
            long skipped = super.skip(Math.min(n, remaining));
            if (skipped > 0) remaining -= skipped;
            return skipped;
        }

        @Override
        public void close() throws IOException {
            try {
                super.close();
            } finally {
                if (afd != null) afd.close();
            }
        }
    }
}
