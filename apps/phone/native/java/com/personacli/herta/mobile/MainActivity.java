package com.personacli.herta.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册：BridgeActivity 在那里面装配 bridge 与插件表。
        registerPlugin(HertaHttpPlugin.class);
        registerPlugin(HertaGalleryPlugin.class);
        registerPlugin(HertaKeepAlivePlugin.class);
        registerPlugin(HertaLocationPlugin.class);
        registerPlugin(HertaNotifyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
