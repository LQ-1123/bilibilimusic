package io.github.lq1123.bilimusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/** Owns the Android foreground notification while WebView audio is playing. */
public final class MediaPlaybackService extends Service {
    static final String CHANNEL = "playback";
    static final int NOTIFICATION_ID = 7101;

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "播放", NotificationManager.IMPORTANCE_LOW));
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent == null ? "BiliMusic" : intent.getStringExtra("title");
        String artist = intent == null ? "" : intent.getStringExtra("artist");
        Notification notification = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.icon).setContentTitle(title == null ? "BiliMusic" : title)
            .setContentText(artist == null ? "" : artist).setOngoing(true).setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC).build();
        startForeground(NOTIFICATION_ID, notification);
        return START_STICKY;
    }

    @Override public void onDestroy() { stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
