package io.github.lq1123.bilimusic;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.JsPromptResult;
import android.webkit.JavascriptInterface;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.content.Intent;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import java.io.File;
import java.io.InputStream;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {
    private WebView web;
    private String origin;
    private TextView statusText;
    private int insTop, insBottom, insLeft, insRight;
    private static WebView activeWeb;

    /** 通知按钮回控页面播放器（MediaPlaybackService 调用，主线程执行）。 */
    static void evalInPage(String js) {
        WebView view = activeWeb;
        if (view != null) view.post(() -> view.evaluateJavascript(js, null));
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        // 启动页：全屏铺 loading_mobile.png 插画 + 底部细字状态行（失败信息也显示在这里）
        float dp = getResources().getDisplayMetrics().density;
        android.widget.FrameLayout splash = new android.widget.FrameLayout(this);
        splash.setBackgroundColor(0xFFFFFFFF);
        ImageView art = new ImageView(this);
        art.setImageResource(R.drawable.loading_mobile);
        art.setScaleType(ImageView.ScaleType.CENTER_CROP);
        splash.addView(art, new android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT));
        statusText = new TextView(this);
        statusText.setText("正在启动…");
        statusText.setTextSize(12.5f);
        statusText.setTextColor(0xFF6B6B78);
        statusText.setGravity(android.view.Gravity.CENTER);
        android.widget.FrameLayout.LayoutParams stLp = new android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
            android.widget.FrameLayout.LayoutParams.WRAP_CONTENT);
        stLp.gravity = android.view.Gravity.BOTTOM;
        stLp.bottomMargin = (int) (36 * dp);
        stLp.leftMargin = stLp.rightMargin = (int) (24 * dp);
        splash.addView(statusText, stLp);
        setContentView(splash);
        setupEdgeToEdge();
        new Thread(() -> {
            try {
                File assets = new File(getFilesDir(), "web");
                copyAssets("static", new File(assets, "static"));
                copyAssets("templates", new File(assets, "templates"));
                if (!Python.isStarted()) Python.start(new AndroidPlatform(this));
                Python py = Python.getInstance();
                py.getModule("os").get("environ").callAttr("__setitem__", "BM_WEB_DIR", assets.getAbsolutePath());
                origin = py.getModule("app.embedded").callAttr("start", new File(getFilesDir(), "data").getAbsolutePath()).toString();
                boolean ready = false;
                for (int i = 0; i < 120; i++) {
                    HttpURLConnection conn = null;
                    try {
                        conn = (HttpURLConnection) new URL(origin + "/openapi.json").openConnection();
                        conn.setConnectTimeout(1000); conn.setReadTimeout(1000);
                        if (conn.getResponseCode() == 200) { ready = true; break; }
                    } catch (Exception ignored) {} finally { if (conn != null) conn.disconnect(); }
                    Thread.sleep(500);
                }
                if (!ready) throw new Exception("Local backend startup timed out");
                runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) showPlayer(); });
            } catch (Exception error) {
                android.util.Log.e("BiliMusic", "Startup failed", error);
                runOnUiThread(() -> { if (!isFinishing()) statusText.setText("启动失败 / Startup failed\n" + error.getMessage()); });
            }
        }, "backend-start").start();
    }

    /** 边到边（#2 方案 B）：内容延伸到透明系统栏下，insets 实时转成页面 CSS 变量。 */
    private void setupEdgeToEdge() {
        android.view.Window decor = getWindow();
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            decor.setDecorFitsSystemWindows(false);
        } else {
            decor.getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        decor.getDecorView().setOnApplyWindowInsetsListener((view, insets) -> {
            int top, bottom, left, right;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets s = insets.getInsets(android.view.WindowInsets.Type.systemBars());
                top = s.top; bottom = s.bottom; left = s.left; right = s.right;
            } else {
                top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft(); right = insets.getSystemWindowInsetRight();
            }
            pushInsets(top, bottom, left, right);
            return insets;
        });
    }

    private void pushInsets(int top, int bottom, int left, int right) {
        insTop = top; insBottom = bottom; insLeft = left; insRight = right;
        if (web == null) return;
        // insets 是物理像素；CSS 变量按 WebView 的 CSS px 消费，必须除以 density
        float d = getResources().getDisplayMetrics().density;
        String js = "document.documentElement.style.setProperty('--inset-top','" + (top / d) + "px');"
            + "document.documentElement.style.setProperty('--inset-bottom','" + (bottom / d) + "px');"
            + "document.documentElement.style.setProperty('--inset-left','" + (left / d) + "px');"
            + "document.documentElement.style.setProperty('--inset-right','" + (right / d) + "px');";
        web.evaluateJavascript(js, null);
    }

    /** 系统栏图标明暗随应用主题（桥由 v3.js setTheme 调用）。 */
    private void applySystemBarTheme(boolean light) {
        android.view.Window decor = getWindow();
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController c = decor.getInsetsController();
            if (c != null) {
                int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(light ? mask : 0, mask);
            }
        } else {
            View decorView = decor.getDecorView();
            int flags = decorView.getSystemUiVisibility();
            if (light) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            else flags &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            decorView.setSystemUiVisibility(flags);
        }
    }

    /** 页面桥：本地可信内容，接口最小（#2 主题跟随 / #18 浏览器登录）。 */
    private Object nativeBridge() {
        return new Object() {
            @JavascriptInterface public void setTheme(String theme) {
                runOnUiThread(() -> applySystemBarTheme("light".equals(theme)));
            }
            @JavascriptInterface public void openExternalLogin() {
                String url = (origin == null ? "" : origin) + "/?login=1";
                runOnUiThread(() -> {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
                });
            }
            @JavascriptInterface public void playbackStarted(String title, String artist, String coverUrl) {
                Intent intent = new Intent(MainActivity.this, MediaPlaybackService.class)
                    .putExtra("title", title).putExtra("artist", artist)
                    .putExtra("cover", coverUrl == null ? "" : coverUrl).putExtra("paused", false);
                if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
            }
            @JavascriptInterface public void playbackProgress(double position, double duration) {
                Intent intent = new Intent(MainActivity.this, MediaPlaybackService.class)
                    .setAction(MediaPlaybackService.ACTION_SYNC)
                    .putExtra("position", (long) position).putExtra("duration", (long) duration);
                startService(intent);
            }
            @JavascriptInterface public void playbackPaused(boolean value) {
                Intent intent = new Intent(MainActivity.this, MediaPlaybackService.class)
                    .setAction(MediaPlaybackService.ACTION_SYNC).putExtra("paused", value);
                startService(intent);
            }
            @JavascriptInterface public void playbackStopped() {
                stopService(new Intent(MainActivity.this, MediaPlaybackService.class));
            }
            /** 登录二维码：存进相册（B 站 App「扫一扫 → 相册」能选到）。 */
            @JavascriptInterface public void saveQrToGallery(String dataUrl) {
                runOnUiThread(() -> saveQr(dataUrl));
            }
            /** 拉起 B 站 App，让用户去扫刚存下的二维码。 */
            @JavascriptInterface public void openBilibiliApp() {
                runOnUiThread(MainActivity.this::launchBilibili);
            }
        };
    }

    /** 登录二维码存进系统相册：B 站 App 的「扫一扫 → 相册」能选到它（单机扫码登录）。 */
    private void saveQr(String dataUrl) {
        if (Build.VERSION.SDK_INT < 29
                && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, 91);
            toast("请允许存储权限后，再点一次二维码");
            return;
        }
        try {
            int comma = dataUrl == null ? -1 : dataUrl.indexOf(',');
            if (comma < 0) return;
            byte[] png = android.util.Base64.decode(
                dataUrl.substring(comma + 1), android.util.Base64.DEFAULT);
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, "bilimusic-login-qr.png");
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
            if (Build.VERSION.SDK_INT >= 29) {
                values.put(MediaStore.Images.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_PICTURES + "/BiliMusic");
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
            }
            Uri uri = getContentResolver().insert(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) { toast("保存失败：相册不可写"); return; }
            try (java.io.OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out != null) out.write(png);
            }
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.Images.Media.IS_PENDING, 0);
                getContentResolver().update(uri, done, null, null);
            }
            toast("二维码已存到相册");
        } catch (Exception e) {
            toast("保存失败：" + e.getClass().getSimpleName());
        }
    }

    /** 拉起 B 站 App；没装则打开下载页。 */
    private void launchBilibili() {
        Intent app = getPackageManager().getLaunchIntentForPackage("tv.danmaku.bili");
        if (app != null) {
            app.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { startActivity(app); return; } catch (Exception ignored) {}
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://app.bilibili.com/")));
        } catch (Exception ignored) {}
    }

    private void toast(String msg) {
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show();
    }

    private void copyAssets(String source, File target) throws Exception {
        String[] children = getAssets().list(source);
        if (children != null && children.length > 0) {
            target.mkdirs();
            for (String child : children) copyAssets(source + "/" + child, new File(target, child));
        } else {
            target.getParentFile().mkdirs();
            try (InputStream in = getAssets().open(source); FileOutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[8192]; int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            }
        }
    }

    private void showPlayer() {
        web = new WebView(this);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        // 短信登录的极验滑块（static.geetest.com）在 WebView 里不渲染，两个主因：
        //   1) 默认 UA 带 "; wv" 被风控识别为 WebView；
        //   2) 跨站脚本的第三方 Cookie 默认被拦（极验会话拿不到）。
        // 伪装成普通手机 Chrome 并放开第三方 Cookie —— 页面布局走 CSS 视口，不受 UA 影响。
        ws.setUserAgentString(
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                + "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36");
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript("Boolean(document.getElementById('app'))", value -> {
                    if ("true".equals(value)) {
                        android.util.Log.i("BiliMusic", "BILIMUSIC_WEB_READY");
                        // 页面导航会清掉内联样式：就绪后按当前 insets 重推 CSS 变量
                        pushInsets(insTop, insBottom, insLeft, insRight);
                    }
                });
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri.toString().startsWith(origin + "/")) return false;
                if ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton(android.R.string.ok,
                    (dialog, which) -> result.confirm()).setOnCancelListener(dialog -> result.cancel()).show();
                return true;
            }
            // WebView 默认不实现 prompt/confirm（JS 侧拿到 null/false）：建歌单、改名、删除确认
            // 等页面内弹窗兜底缺失时的最后防线（#7）
            @Override public boolean onJsPrompt(WebView view, String url, String message,
                    String defaultValue, JsPromptResult result) {
                EditText input = new EditText(MainActivity.this);
                input.setText(defaultValue);
                input.setSelection(input.getText().length());
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle(message)
                    .setView(input)
                    .setPositiveButton(android.R.string.ok,
                        (dialog, which) -> result.confirm(input.getText().toString()))
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message)
                    .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                    .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }
        });
        web.addJavascriptInterface(nativeBridge(), "BiliMusicNative");
        // debug 构建开放 WebView 远程调试（验收手册的 chrome://inspect 依赖此项）
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        setContentView(web);
        activeWeb = web; // 供通知按钮回控页面播放器（#3 第一段）
        // Android 13+ 通知需要运行时权限：首次进入请求一次
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 7101);
        }
        // 后端就绪：WebView 200ms 淡入，替代硬切（#9）
        web.setAlpha(0f);
        web.animate().alpha(1f).setDuration(200).start();
        web.loadUrl(origin);
    }
    @Override public void onBackPressed() {
        // WebView 的 canGoBack()/goBack() 不认 pushState 的同文档历史（skippable entry），
        // 改为问页面是否有浮层开着（back-stack.js 的 __backStackDepth）：>0 走 history.back() 关层
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("(window.__backStackDepth?window.__backStackDepth():0)", value -> {
            if ("0".equals(value)) doDefaultBack();
            else web.evaluateJavascript("history.back()", null);
        });
    }
    private void doDefaultBack() {
        runOnUiThread(() -> {
            if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
        });
    }
    @Override protected void onDestroy() {
        if (web != null) web.destroy();
        activeWeb = null;
        super.onDestroy();
    }
}
