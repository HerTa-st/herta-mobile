package com.personacli.herta.mobile;

import android.content.Intent;
import android.media.session.MediaController;
import android.media.session.PlaybackState;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * 通知与媒体会话的桥。
 *
 * 授权只能由用户手动去系统里开（"通知使用权"），所以这里提供一个 status 与一个
 * openSettings：先说清楚"没开"，再把人送到那一页，而不是让她在对话里反复失败。
 */
@CapacitorPlugin(name = "HertaNotify")
public class HertaNotifyPlugin extends Plugin {

    private boolean hasAccess() {
        String flat = Settings.Secure.getString(
                getContext().getContentResolver(),
                "enabled_notification_listeners"
        );
        return flat != null && flat.contains(getContext().getPackageName());
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("enabled", hasAccess());
        out.put("connected", HertaNotifyService.get() != null);
        call.resolve(out);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("打不开通知使用权那一页：" + e.getMessage());
        }
    }

    @PluginMethod
    public void recent(PluginCall call) {
        if (!hasAccess()) {
            call.reject("还没开「通知使用权」——去设置里给她，不然她读不到。");
            return;
        }
        int limit = call.getInt("limit", 10);
        if (limit <= 0 || limit > 24) limit = 10;
        List<HertaNotifyService.Item> list = HertaNotifyService.recent(limit);
        JSArray arr = new JSArray();
        for (HertaNotifyService.Item it : list) {
            JSObject row = new JSObject();
            row.put("app", it.app);
            row.put("title", it.title);
            row.put("text", it.text);
            row.put("at", it.at);
            arr.put(row);
        }
        JSObject out = new JSObject();
        out.put("notifications", arr);
        call.resolve(out);
    }

    @PluginMethod
    public void nowPlaying(PluginCall call) {
        if (!hasAccess()) {
            call.reject("还没开「通知使用权」——看正在放什么也要它。");
            return;
        }
        String text = HertaNotifyService.nowPlayingText(getContext());
        JSObject out = new JSObject();
        out.put("playing", text);
        call.resolve(out);
    }

    @PluginMethod
    public void media(PluginCall call) {
        if (!hasAccess()) {
            call.reject("还没开「通知使用权」——控制播放也要它。");
            return;
        }
        String action = call.getString("action", "toggle");
        MediaController c = HertaNotifyService.pick(getContext());
        if (c == null) {
            call.reject("没找到正在放东西的 App。");
            return;
        }
        try {
            MediaController.TransportControls t = c.getTransportControls();
            PlaybackState st = c.getPlaybackState();
            boolean playing = st != null && st.getState() == PlaybackState.STATE_PLAYING;
            switch (action) {
                case "play":
                    t.play();
                    break;
                case "pause":
                    t.pause();
                    break;
                case "next":
                    t.skipToNext();
                    break;
                case "previous":
                    t.skipToPrevious();
                    break;
                default:
                    if (playing) t.pause();
                    else t.play();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("那个 App 不让别人控制它：" + e.getMessage());
        }
    }
}
