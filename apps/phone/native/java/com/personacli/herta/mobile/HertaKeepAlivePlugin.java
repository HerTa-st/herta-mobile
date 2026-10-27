package com.personacli.herta.mobile;

import android.content.Intent;
import android.os.Build;

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
