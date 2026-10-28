package com.personacli.herta.mobile;

import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 备份文件的落地与分享。
 *
 * 为什么这一步必须原生：WebView 里 a[download] 在 Capacitor 下不触发下载，
 * 而"换机"要的是把文件丢进微信/文件传输，只有系统的分享面板做得到。
 *
 * 两条路：
 *   share —— 写进缓存目录，用 FileProvider 换一个 content:// URI，弹分享面板；
 *   save  —— 写进应用的外部目录（Android/data/.../files/exports），文件管理器里能找到。
 *
 * 都不需要任何权限：缓存目录和外部应用目录都归自己。
 */
@CapacitorPlugin(name = "HertaBackup")
public class HertaBackupPlugin extends Plugin {

    private File write(String filename, String text, boolean cache) throws Exception {
        String safe = String.valueOf(filename == null ? "" : filename).replaceAll("[^A-Za-z0-9._-]", "_");
        if (safe.isEmpty()) safe = "herta-backup.json";
        File base = cache ? getContext().getCacheDir() : getContext().getExternalFilesDir(null);
        File dir = new File(base, "exports");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("建不了导出目录");
        File file = new File(dir, safe);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
        return file;
    }

    @PluginMethod
    public void share(PluginCall call) {
        String filename = call.getString("filename", "herta-backup.json");
        String text = call.getString("text", "");
        if (text == null || text.isEmpty()) {
            call.reject("包里是空的。");
            return;
        }
        try {
            File file = write(filename, text, true);
            Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    file
            );
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("application/json");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_SUBJECT, filename);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "备份发到哪儿");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            JSObject out = new JSObject();
            out.put("bytes", file.length());
            call.resolve(out);
        } catch (Exception e) {
            call.reject("分享失败：" + e.getMessage());
        }
    }

    @PluginMethod
    public void save(PluginCall call) {
        String filename = call.getString("filename", "herta-backup.json");
        String text = call.getString("text", "");
        if (text == null || text.isEmpty()) {
            call.reject("包里是空的。");
            return;
        }
        try {
            File file = write(filename, text, false);
            JSObject out = new JSObject();
            out.put("path", file.getAbsolutePath());
            out.put("bytes", file.length());
            call.resolve(out);
        } catch (Exception e) {
            call.reject("保存失败：" + e.getMessage());
        }
    }
}
