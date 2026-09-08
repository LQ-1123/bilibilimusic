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
        updateSessionState();
        startForeground(NOTIFICATION_ID, buildNotification());
        return START_STICKY;
    }

    private void updateSessionState() {
        session.setMetadata(new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, lastTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, lastArtist)
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
                positionMs * 1000L, speed)
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
                InputStream in = (InputStream) new URL(url).getContent();
                Bitmap bitmap = BitmapFactory.decodeStream(in);
                if (bitmap != null && url.equals(lastCoverUrl)) {
                    lastCover = bitmap;
                    mainHandler.post(() -> { if (running) startForeground(NOTIFICATION_ID, buildNotification()); });
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
        if (session != null) { session.release(); session = null; }
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
