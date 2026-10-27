package com.personacli.herta.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 常驻服务：只做一件事——让这个进程活着。
 *
 * 为什么需要它：Android 会在 App 退到后台后冻结进程，WebView 里的定时器跟着停，
 * 她就永远"醒不过来"给你发那句主动消息。前台服务是唯一不需要你手动打开 App
 * 也能保住进程的公开办法。
 *
 * 代价写在设置页里：通知栏会一直挂一条（系统不允许隐藏前台通知），国产 ROM
 * 还会杀后台，得你在系统里加白名单。她是不是"一直在"这件事，由用户决定。
 *
 * 不做定时：时间推进放在 JS 那边（她的人格、记忆、模型调用都在那儿），
 * 这个服务只保证"到点时 JS 还活着"。服务自己排闹钟的话，到点叫醒的是一个
 * 没有 WebView 的进程，那才是真的麻烦。
 */
public class HertaKeeperService extends Service {

    public static final String CHANNEL_ID = "herta_keeper";
    public static final int NOTIFICATION_ID = 41;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        Notification note = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14 起前台服务必须声明类型；specialUse 要在 manifest 里写清楚为什么
            startForeground(NOTIFICATION_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, note);
        }
        // START_STICKY：被系统杀掉之后由它自己回来，不用等用户再点开一次
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "她在后台",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("她不说话的时候也还醒着");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(
                this,
                0,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return b
                .setContentTitle("她在后台等着")
                .setContentText("点开继续")
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentIntent(tap)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(Notification.PRIORITY_LOW)
                .build();
    }
}
