package com.personacli.herta.mobile;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;

import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** 系统栏样式只在确认"真的边到边"之后设一次，别在旧系统上把黑底状态栏改成深色图标。 */
    private boolean barsStyled = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册：BridgeActivity 在那里面装配 bridge 与插件表。
        registerPlugin(HertaHttpPlugin.class);
        registerPlugin(HertaGalleryPlugin.class);
        registerPlugin(HertaKeepAlivePlugin.class);
        registerPlugin(HertaLocationPlugin.class);
        registerPlugin(HertaNotifyPlugin.class);
        registerPlugin(HertaA11yPlugin.class);
        registerPlugin(HertaBackupPlugin.class);
        super.onCreate(savedInstanceState);
        applySystemBarInsets();
    }

    /**
     * Android 15 起，targetSdk 35+ 的应用被强制"边到边"：状态栏和手势条直接压在页面上
     * （设置页最明显——标题和时钟叠在一起）。WebView 的 env(safe-area-inset-*) 在
     * Android 上拿不到真值，所以这里自己量系统栏高度，给内容区让开。
     *
     * 旧系统上窗口本来就让开了，这里收到的是 0，不会双重留白；也就不会动它那条
     * 原本就是深色的状态栏（深色图标会看不见）。
     */
    private void applySystemBarInsets() {
        // 让出来的两条铺成页面同款渐变，不然状态栏底下是一条突兀的白
        getWindow().setBackgroundDrawable(ContextCompat.getDrawable(this, R.drawable.window_background));

        final View content = findViewById(android.R.id.content);
        if (content == null) return;

        ViewCompat.setOnApplyWindowInsetsListener(content, (view, insets) -> {
            Insets sys = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            if (sys.top > 0 && !barsStyled) {
                barsStyled = true;
                styleBarsForLightBackground();
            }
            if (view.getPaddingTop() != sys.top
                || view.getPaddingBottom() != sys.bottom
                || view.getPaddingLeft() != sys.left
                || view.getPaddingRight() != sys.right) {
                view.setPadding(sys.left, sys.top, sys.right, sys.bottom);
            }
            return insets;
        });
        ViewCompat.requestApplyInsets(content);
    }

    /** 浅色页面配深色图标；两条系统栏都透明，露出下面那层渐变。 */
    @SuppressWarnings("deprecation")
    private void styleBarsForLightBackground() {
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);
    }
}
