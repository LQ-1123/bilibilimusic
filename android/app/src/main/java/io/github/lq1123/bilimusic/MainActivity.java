package io.github.lq1123.bilimusic;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebChromeClient;
import android.webkit.JsResult;
import android.widget.TextView;
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

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView loading = new TextView(this);
        loading.setText("BiliMusic\n正在启动 / Starting...");
        loading.setGravity(android.view.Gravity.CENTER);
        setContentView(loading);
        getWindow().getDecorView().setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
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
                runOnUiThread(() -> { if (!isFinishing()) loading.setText("启动失败 / Startup failed\n" + error.getMessage()); });
            }
        }, "backend-start").start();
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
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript("Boolean(document.getElementById('app'))", value -> {
                    if ("true".equals(value)) android.util.Log.i("BiliMusic", "BILIMUSIC_WEB_READY");
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
        });
        setContentView(web);
        web.loadUrl(origin);
    }
    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
