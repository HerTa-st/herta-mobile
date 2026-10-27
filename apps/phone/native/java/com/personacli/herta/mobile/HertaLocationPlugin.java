package com.personacli.herta.mobile;

import android.Manifest;
import android.content.Context;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 定位，一次。
 *
 * 不用 @capacitor/geolocation：它拉 com.google.android.gms:play-services-location，
 * 为了几个经纬度把包撑大四兆。LocationManager 是系统自带的，零依赖。
 *
 * 只做"现在在哪儿"这一件事：不注册持续监听、不留后台、不做逆地理编码。
 * 拿不到就明说拿不到，不要挂在那儿等——她那边在等一个答案。
 */
@CapacitorPlugin(
        name = "HertaLocation",
        permissions = {
                @Permission(alias = "fine", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
                @Permission(alias = "coarse", strings = { Manifest.permission.ACCESS_COARSE_LOCATION })
        })
public class HertaLocationPlugin extends Plugin {

    private static final long TIMEOUT_MS = 12000;

    private boolean granted() {
        return getPermissionState("fine") == PermissionState.GRANTED
                || getPermissionState("coarse") == PermissionState.GRANTED;
    }

    @PluginMethod
    public void getCurrent(PluginCall call) {
        if (!granted()) {
            // 先要精确定位；用户只给大致位置也认（她只需要知道在哪个城市）
            requestPermissionForAlias("fine", call, "onPermissionResult");
            return;
        }
        resolveWith(call);
    }

    @PermissionCallback
    private void onPermissionResult(PluginCall call) {
        if (!granted()) {
            call.reject("系统没给定位权限——去设置里允许，不然她不知道你在哪。");
            return;
        }
        resolveWith(call);
    }

    private void resolveWith(PluginCall call) {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            call.reject("这台机器没有定位服务。");
            return;
        }

        // 先试缓存：绝大多数时候"上一次已知位置"就够，而且立刻返回
        Location best = null;
        try {
            for (String provider : lm.getProviders(true)) {
                Location got = lm.getLastKnownLocation(provider);
                if (got != null && (best == null || got.getTime() > best.getTime())) best = got;
            }
        } catch (SecurityException ignored) {
            // 权限在两次检查之间被撤掉了
        }
        if (best != null && System.currentTimeMillis() - best.getTime() < 10 * 60 * 1000) {
            resolveWith(best, call);
            return;
        }

        // 缓存太旧：要一次定位，最多等 12 秒。
        // 注意这几个"容器"：lambda 只能捕获 final，而 best 是后面才可能被填上的。
        final LocationManager manager = lm;
        final Location[] cached = new Location[] { best };
        final LocationListener[] holder = new LocationListener[1];
        final boolean[] done = new boolean[] { false };

        holder[0] = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                if (done[0]) return;
                done[0] = true;
                try {
                    manager.removeUpdates(holder[0]);
                } catch (SecurityException ignored) {
                    // 移除失败不影响这次结果
                }
                resolveWith(location, call);
            }

            @Override
            public void onProviderEnabled(String provider) {}

            @Override
            public void onProviderDisabled(String provider) {}

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {}
        };

        try {
            String provider = manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                    ? LocationManager.NETWORK_PROVIDER
                    : LocationManager.GPS_PROVIDER;
            manager.requestLocationUpdates(provider, 0L, 0f, holder[0], Looper.getMainLooper());
        } catch (SecurityException e) {
            call.reject("系统没给定位权限。");
            return;
        } catch (Exception e) {
            call.reject("定位起不来：" + e.getMessage());
            return;
        }

        new android.os.Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (done[0]) return;
            done[0] = true;
            try {
                manager.removeUpdates(holder[0]);
            } catch (Exception ignored) {
                // 已经没了
            }
            if (cached[0] != null) {
                resolveWith(cached[0], call);
            } else {
                call.reject("等了十几秒还是没定位到——可能室内收不到信号。");
            }
        }, TIMEOUT_MS);
    }

    private void resolveWith(Location location, PluginCall call) {
        JSObject out = new JSObject();
        out.put("latitude", location.getLatitude());
        out.put("longitude", location.getLongitude());
        if (location.hasAccuracy()) out.put("accuracy", location.getAccuracy());
        call.resolve(out);
    }
}
