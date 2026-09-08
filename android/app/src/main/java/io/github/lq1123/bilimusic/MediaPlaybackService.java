package io.github.lq1123.bilimusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.core.app.NotificationCompat;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Owns the Android foreground media notification while WebView audio is playing (#3 第一段). */
public final class MediaPlaybackService extends Service {
    static final String CHANNEL = "playback";
    static final int NOTIFICATION_ID = 7101;
    static final String ACTION_TOGGLE = "io.github.lq1123.bilimusic.TOGGLE";
    static final String ACTION_PREV = "io.github.lq1123.bilimusic.PREV";
    static final String ACTION_NEXT = "io.github.lq1123.bilimusic.NEXT";
    static final String ACTION_SYNC = "io.github.lq1123.bilimusic.SYNC";

    private static String lastTitle = "BiliMusic";
    private static String lastArtist = "";
    private static String lastCoverUrl = "";
    private static Bitmap lastCover;
    private static long lastPosition = 0;
    private static long lastDuration = 0;
    private static boolean paused = true;

    private MediaSessionCompat session;

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "播放", NotificationManager.IMPORTANCE_LOW));
        }
        // 媒体会话：锁屏/蓝牙/耳机线控按钮统一回控 WebView 播放器
        session = new MediaSessionCompat(this, "BiliMusic");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { MainActivity.evalInPage("BiliPlayer.toggle()"); }
            @Override public void onPause() { MainActivity.evalInPage("BiliPlayer.toggle()"); }
            @Override public void onSkipToNext() { MainActivity.evalInPage("BiliPlayer.skip(1)"); }
            @Override public void onSkipToPrevious() { MainActivity.evalInPage("BiliPlayer.skip(-1)"); }
        });
        // 媒体按钮/传输控件要显式打开，否则媒体卡上的按钮与点按无响应（#29）
        session.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
            | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
        // 点通知栏/锁屏媒体卡回到 App（此前点不动）
        Intent activityIntent = new Intent(this, MainActivity.class);
        activityIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        session.setSessionActivity(PendingIntent.getActivity(this, 0, activityIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        session.setActive(true);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        running = true;
        String action = intent == null ? ACTION_SYNC : intent.getAction();
        if (ACTION_TOGGLE.equals(action)) { MainActivity.evalInPage("BiliPlayer.toggle()"); return START_STICKY; }
        if (ACTION_PREV.equals(action)) { MainActivity.evalInPage("BiliPlayer.skip(-1)"); return START_STICKY; }
        if (ACTION_NEXT.equals(action)) { MainActivity.evalInPage("BiliPlayer.skip(1)"); return START_STICKY; }
        if (intent != null) {
            String title = intent.getStringExtra("title");
            String artist = intent.getStringExtra("artist");
            String cover = intent.getStringExtra("cover");
            if (title != null) lastTitle = title;
            if (artist != null) lastArtist = artist;
            if (cover != null && !cover.equals(lastCoverUrl)) { lastCoverUrl = cover; lastCover = null; loadCover(cover); }
            lastPosition = intent.getLongExtra("position", lastPosition);
            lastDuration = intent.getLongExtra("duration", lastDuration);
            paused = intent.getBooleanExtra("paused", paused);
        }
        registerNoisyReceiver();
        updateSessionState();
        startForeground(NOTIFICATION_ID, buildNotification());
        return START_STICKY;
    }

    // 耳机拔出（#4）：AUDIO_BECOMING_NOISY 时暂停页面播放（Chromium 不处理此广播）
    private android.content.BroadcastReceiver noisyReceiver;

    private void registerNoisyReceiver() {
        if (noisyReceiver != null) return;
        noisyReceiver = new android.content.BroadcastReceiver() {
            @Override public void onReceive(android.content.Context context, android.content.Intent intent) {
                android.util.Log.i("BiliMusic", "BECOMING_NOISY received -> pause page");
                // 直接暂停媒体元素（pause 事件会同步 UI 与壳层通知图标；toggle 在暂停态会误恢复）
                MainActivity.evalInPage("document.getElementById('audio').pause()");
                paused = true;
                startForeground(NOTIFICATION_ID, buildNotification());
                updateSessionState();
            }
        };
        registerReceiver(noisyReceiver, new android.content.IntentFilter(android.media.AudioManager.ACTION_AUDIO_BECOMING_NOISY));
    }

    private void unregisterNoisyReceiver() {
        if (noisyReceiver != null) {
            unregisterReceiver(noisyReceiver);
            noisyReceiver = null;
        }
    }

    private void updateSessionState() {
        session.setMetadata(new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, lastTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, lastArtist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "BiliMusic")
            // ART 是系统媒体卡/锁屏最常读的封面键；ALBUM_ART 保留兼容（#29）
            .putBitmap(MediaMetadataCompat.METADATA_KEY_ART, lastCover)
            .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, lastCover)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, lastDuration * 1000L)
            .build());
        long positionMs = lastPosition * 1000L;
        float speed = paused ? 0f : 1f;
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)
            .setState(paused ? PlaybackStateCompat.STATE_PAUSED : PlaybackStateCompat.STATE_PLAYING,
                positionMs, speed)
            .build());
    }

    private Notification buildNotification() {
        NotificationCompat.Style style = new androidx.media.app.NotificationCompat.MediaStyle()
            .setMediaSession(session.getSessionToken())
            .setShowActionsInCompactView(0, 1, 2);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.icon).setContentTitle(lastTitle).setContentText(lastArtist)
            .setOngoing(true).setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(new NotificationCompat.Action(android.R.drawable.ic_media_previous, "上一首", servicePendingIntent(ACTION_PREV)))
            .addAction(new NotificationCompat.Action(paused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause,
                "播放/暂停", servicePendingIntent(ACTION_TOGGLE)))
            .addAction(new NotificationCompat.Action(android.R.drawable.ic_media_next, "下一首", servicePendingIntent(ACTION_NEXT)))
            .setStyle(style);
        if (lastCover != null) builder.setLargeIcon(lastCover);
        if (lastDuration > 0) builder.setProgress((int) lastDuration, (int) lastPosition, false);
        return builder.build();
    }

    private void loadCover(String url) {
        new Thread(() -> {
            try {
                // 裸 URL.getContent() 无 UA/Referer，B 站图床可能 403 —— 显式补头（#29）
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13)");
                conn.setRequestProperty("Referer", "https://www.bilibili.com/");
                InputStream in = conn.getInputStream();
                Bitmap bitmap = BitmapFactory.decodeStream(in);
                try { in.close(); } catch (Exception closeErr) {}
                conn.disconnect();
                // 竞态保护：解码期间可能已切歌，url 不再是当前封面就丢弃
                if (bitmap != null && url.equals(lastCoverUrl)) {
                    lastCover = bitmap;
                    mainHandler.post(() -> { if (running) { updateSessionState(); startForeground(NOTIFICATION_ID, buildNotification()); } });
                }
            } catch (Exception ignored) {
            }
        }, "cover-loader").start();
    }

    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean running = false;

    private PendingIntent servicePendingIntent(String action) {
        return PendingIntent.getService(this, action.hashCode(),
            new Intent(this, MediaPlaybackService.class).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override public void onDestroy() {
        running = false;
        unregisterNoisyReceiver();
        if (session != null) { session.release(); session = null; }
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
