package com.personacli.herta.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * 无障碍的桥：状态、开关、白名单、读屏、点一下。
 *
 * 白名单不放在 JS 的 localStorage 里：服务在原生侧判断"这个 App 许不许"，
 * 判断依据必须和被判断的对象住在一起。放 JS 里等于把门锁挂在门外。
 */
@CapacitorPlugin(name = "HertaA11y")
public class HertaA11yPlugin extends Plugin {

    private boolean enabled() {
        String flat = Settings.Secure.getString(
                getContext().getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        if (flat == null) return false;
        return flat.contains(getContext().getPackageName() + "/" + HertaA11yService.class.getCanonicalName());
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("enabled", enabled());
        out.put("connected", HertaA11yService.get() != null);
        call.resolve(out);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("打不开无障碍设置：" + e.getMessage());
        }
    }

    @PluginMethod
    public void getWhitelist(PluginCall call) {
        JSObject out = new JSObject();
        JSArray arr = new JSArray();
        for (String p : readWhitelist(getContext())) arr.put(p);
        out.put("packages", arr);
        call.resolve(out);
    }

    @PluginMethod
    public void setWhitelist(PluginCall call) {
        JSArray arr = call.getArray("packages");
        List<String> list = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i += 1) {
                String p = arr.optString(i, "");
                if (!p.isEmpty()) list.add(p);
            }
        }
        SharedPreferences sp = getContext().getSharedPreferences(HertaA11yService.PREFS, Context.MODE_PRIVATE);
        sp.edit().putString(HertaA11yService.KEY_WHITELIST, String.join(",", list)).apply();
        call.resolve();
    }

    /** 手机上装了、且能点开的那些应用，给白名单挑。 */
    @PluginMethod
    public void listApps(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN, null);
        main.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> ris = pm.queryIntentActivities(main, 0);
        List<JSObject> rows = new ArrayList<>();
        for (ResolveInfo ri : ris) {
            if (ri.activityInfo == null) continue;
            String pkg = ri.activityInfo.packageName;
            if (pkg == null) continue;
            JSObject row = new JSObject();
            row.put("pkg", pkg);
            if (pkg.equals(getContext().getPackageName())) {
                // 本应用也列出来：用户明确要求她能读自己的界面（比如"我这句话你写的什么"）。
                // 不默认放行，还是得在这里勾一次——范围得由用户划。
                row.put("label", "Herta（她自己）");
            } else {
                try {
                    ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                    row.put("label", String.valueOf(pm.getApplicationLabel(ai)));
                } catch (Exception e) {
                    row.put("label", pkg);
                }
            }
            rows.add(row);
        }
        Collections.sort(rows, Comparator.comparing(o -> String.valueOf(o.optString("label", "")).toLowerCase()));
        JSArray arr = new JSArray();
        for (JSObject row : rows) arr.put(row);
        JSObject out = new JSObject();
        out.put("apps", arr);
        call.resolve(out);
    }

    @PluginMethod
    public void snapshot(PluginCall call) {
        HertaA11yService svc = HertaA11yService.get();
        if (svc == null) {
            call.reject("无障碍服务没在跑——去系统设置里把它打开。");
            return;
        }
        String pkg = svc.currentPackage();
        if (!svc.allowed(pkg)) {
            call.reject("当前这个 App 不在白名单里（" + pkg + "）。想让她看，先在设置里勾上。");
            return;
        }
        int max = call.getInt("max", 60);
        if (max <= 0 || max > 200) max = 60;
        List<String> lines = svc.snapshot(max);
        JSArray arr = new JSArray();
        for (String l : lines) arr.put(l);
        JSObject out = new JSObject();
        out.put("package", pkg);
        out.put("lines", arr);
        call.resolve(out);
    }

    @PluginMethod
    public void tap(PluginCall call) {
        HertaA11yService svc = HertaA11yService.get();
        if (svc == null) {
            call.reject("无障碍服务没在跑——去系统设置里把它打开。");
            return;
        }
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("要说点哪个字。");
            return;
        }
        String pkg = svc.currentPackage();
        if (!svc.allowed(pkg)) {
            call.reject("当前这个 App 不在白名单里（" + pkg + "）。");
            return;
        }
        String result = svc.tap(text.trim());
        call.resolve(new JSObject().put("note", result));
    }

    private static List<String> readWhitelist(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(HertaA11yService.PREFS, Context.MODE_PRIVATE);
        String raw = sp.getString(HertaA11yService.KEY_WHITELIST, "");
        List<String> out = new ArrayList<>();
        if (raw == null || raw.trim().isEmpty()) return out;
        for (String p : raw.split(",")) {
            if (!p.trim().isEmpty()) out.add(p.trim());
        }
        return out;
    }
}
