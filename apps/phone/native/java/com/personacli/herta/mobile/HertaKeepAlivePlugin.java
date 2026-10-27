package com.personacli.herta.mobile;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 常驻服务的开关。
 *
 * 只有两个方法：start / stop。没有"状态查询"——JS 那边自己记着它开没开，
 * 再问一遍原生只会多一种"两边不一致"的错法。
 */
@CapacitorPlugin(name = "HertaKeepAlive")
public class HertaKeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), HertaKeeperService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            // 系统不让起（没有前台服务权限、或用户把通知全关了）
            call.reject("起不来常驻服务：" + e.getMessage());
        }
    }

    /**
     * 打开本应用的系统详情页。
     *
     * 电池优化白名单没有公开的"一键加入"接口（那需要 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS，
     * 应用商店会盯着这个权限），能做的就是把人送到该点的那一页：
     * 详情页 → 电池 → 不受限制。少走三层路，已经够意思了。
     */
    @PluginMethod
    public void openSystemSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("打不开系统设置：" + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), HertaKeeperService.class));
            call.resolve();
        } catch (Exception e) {
            call.reject("关不掉常驻服务：" + e.getMessage());
        }
    }
}
