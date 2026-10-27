package com.personacli.herta.mobile;

import android.app.Notification;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 读通知栏 + 看/控正在放的音乐。
 *
 * 两件事共用一份系统授权（"通知使用权"），所以做成一个服务：
 * 用户去系统设置里开一次，这两样一起到手；关了，两样一起没。
 *
 * 边界刻意很紧：
 *   - 只留最近 24 条，只存 应用名 / 标题 / 正文 / 时间，**不落盘**（进程死了就没了）；
 *   - 跳过本应用自己的通知（不然她会把自己那条"在后台等着"也读进来）；
 *   - 媒体只读当前会话的标题与播放状态，控制只发播放/暂停/上一首/下一首。
 *
 * 为什么不做成"常驻监听 + 推送"：她只在被叫到的那一轮里看这几条，
 * 主动盯着你的通知栏是另一件事，没经过这一步的同意不能顺手做。
 */
public class HertaNotifyService extends NotificationListenerService {

    /** 活着的那个实例；插件通过它取数据。 */
    private static HertaNotifyService instance;

    private static final int MAX_KEEP = 24;

    /** 最近的通知（key 用 sbn.getKey()，同一条更新会覆盖而不是堆两份）。 */
    private static final LinkedHashMap<String, Item> RECENT = new LinkedHashMap<String, Item>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Item> eldest) {
            return size() > MAX_KEEP;
        }
    };

    public static class Item {
        public String app = "";
        public String title = "";
        public String text = "";
        public long at = 0;
        public String pkg = "";
    }

    public static HertaNotifyService get() {
        return instance;
    }

    public static List<Item> recent(int limit) {
        List<Item> all;
        synchronized (RECENT) {
            all = new ArrayList<>(RECENT.values());
        }
        // 新的在前
        java.util.Collections.reverse(all);
        return all.size() > limit ? all.subList(0, limit) : all;
    }

    public static void clear() {
        synchronized (RECENT) {
            RECENT.clear();
        }
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        instance = this;
    }

    @Override
    public void onListenerDisconnected() {
        instance = null;
        super.onListenerDisconnected();
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null) return;
        String pkg = sbn.getPackageName();
        if (pkg == null || pkg.equals(getPackageName())) return;
        if ((sbn.getNotification().flags & Notification.FLAG_ONGOING_EVENT) != 0) return;

        Bundle extras = sbn.getNotification().extras;
        if (extras == null) return;

        String title = str(extras.getCharSequence(Notification.EXTRA_TITLE));
        String text = str(extras.getCharSequence(Notification.EXTRA_TEXT));
        if (text.isEmpty()) text = str(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        if (title.isEmpty() && text.isEmpty()) return;

        Item item = new Item();
        item.app = appLabel(pkg);
        item.pkg = pkg;
        item.title = cut(title, 60);
        item.text = cut(text, 140);
        item.at = sbn.getPostTime();
        synchronized (RECENT) {
            RECENT.put(sbn.getKey(), item);
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        if (sbn == null) return;
        synchronized (RECENT) {
            RECENT.remove(sbn.getKey());
        }
    }

    /* ------------------------------------------------------------ 媒体 */

    /** 当前在放东西的那些会话（同一个授权给的）。 */
    public static List<MediaController> sessions(Context ctx) {
        List<MediaController> out = new ArrayList<>();
        try {
            MediaSessionManager mgr = (MediaSessionManager) ctx.getSystemService(Context.MEDIA_SESSION_SERVICE);
            if (mgr == null) return out;
            ComponentName listener = new ComponentName(ctx, HertaNotifyService.class);
            out.addAll(mgr.getActiveSessions(listener));
        } catch (Exception ignored) {
            // 没有通知使用权时会抛 SecurityException：当作"看不到"
        }
        return out;
    }

    /** 挑一个"正在放或最近在放"的会话；都没有就返回第一个。 */
    public static MediaController pick(Context ctx) {
        List<MediaController> all = sessions(ctx);
        if (all.isEmpty()) return null;
        for (MediaController c : all) {
            PlaybackState st = c.getPlaybackState();
            if (st != null && st.getState() == PlaybackState.STATE_PLAYING) return c;
        }
        return all.get(0);
    }

    public static String nowPlayingText(Context ctx) {
        MediaController c = pick(ctx);
        if (c == null) return "";
        MediaMetadata md = c.getMetadata();
        String title = md == null ? "" : str(md.getText(MediaMetadata.METADATA_KEY_TITLE));
        String artist = md == null ? "" : str(md.getText(MediaMetadata.METADATA_KEY_ARTIST));
        PlaybackState st = c.getPlaybackState();
        boolean playing = st != null && st.getState() == PlaybackState.STATE_PLAYING;
        String app = labelOf(ctx, c.getPackageName());
        if (title.isEmpty() && artist.isEmpty()) return "";
        return (playing ? "在放" : "暂停") + "：" + app + " · " + title + (artist.isEmpty() ? "" : " — " + artist);
    }

    private String appLabel(String pkg) {
        return labelOf(this, pkg);
    }

    private static String labelOf(Context ctx, String pkg) {
        try {
            PackageManager pm = ctx.getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(ai));
        } catch (Exception e) {
            return pkg;
        }
    }

    private static String str(CharSequence cs) {
        return cs == null ? "" : cs.toString().trim();
    }

    private static String cut(String s, int max) {
        String flat = s.replaceAll("\\s+", " ").trim();
        return flat.length() > max ? flat.substring(0, max) + "…" : flat;
    }
}
