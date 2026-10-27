package com.personacli.herta.mobile;

import android.Manifest;
import android.content.ContentUris;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * 相册。
 *
 * 两件事：列出最近的照片（只给 id / 名字 / 时间，**不含图像数据**），
 * 以及按 id 读出一张（解码时缩到长边 1024、JPEG 80）。
 *
 * 为什么分成两步：她翻相册时不该把几十张原图全塞进上下文。
 * 先看目录（便宜），决定要看哪张，再读那一张。
 *
 * 权限：Android 13 起是 READ_MEDIA_IMAGES，再往下是 READ_EXTERNAL_STORAGE。
 * 这里用 Capacitor 的 handleRequestPermissionsResult 手工接回调，
 * 因为要按版本选权限常量，注解那套写不了条件。
 */
@CapacitorPlugin(
        name = "HertaGallery",
        permissions = {
                // Android 13 起照片属于"媒体"，不再是"存储"
                @Permission(alias = "images", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
                @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
        })
public class HertaGalleryPlugin extends Plugin {

    private static final int MAX_SIDE = 1024;

    /** 桥上传来的数字可能是 Integer / Long / Double，模型偶尔还会写成字符串。统一收成 Long。 */
    private static Long asLong(Object value) {
        if (value instanceof Number) {
            return ((Number) value).longValue();
        }
        if (value instanceof String) {
            try {
                return Long.parseLong(((String) value).trim());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private String alias() {
        return Build.VERSION.SDK_INT >= 33 ? "images" : "storage";
    }

    /**
     * 申请相册权限。
     *
     * 用 Capacitor 的注解式申请（requestPermissionForAlias + @PermissionCallback），
     * 不要自己 ActivityCompat.requestPermissions —— 手动申请的回调不一定转给插件，
     * 表现就是"弹窗没出现，然后什么都没发生"。
     */
    @PluginMethod
    public void ensurePermission(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            JSObject o = new JSObject();
            o.put("granted", true);
            call.resolve(o);
            return;
        }
        requestPermissionForAlias(alias(), call, "onPermissionResult");
    }

    @PermissionCallback
    private void onPermissionResult(PluginCall call) {
        JSObject o = new JSObject();
        o.put("granted", getPermissionState(alias()) == PermissionState.GRANTED);
        call.resolve(o);
    }

    /** 最近的若干张。只给元数据——她先看目录，再决定看哪张。 */
    @PluginMethod
    public void list(PluginCall call) {
        int limit = call.getInt("limit", 40);
        JSArray out = new JSArray();
        Uri uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        String[] cols = {
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.DATE_ADDED,
        };
        Cursor cursor = null;
        try {
            cursor = getContext().getContentResolver().query(
                    uri, cols, null, null, MediaStore.Images.Media.DATE_ADDED + " DESC");
            if (cursor != null) {
                int idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
                int nameCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME);
                int dateCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED);
                int n = 0;
                while (cursor.moveToNext() && n < limit) {
                    JSObject item = new JSObject();
                    item.put("id", cursor.getLong(idCol));
                    item.put("name", cursor.getString(nameCol));
                    // 秒 → 毫秒，前端直接 new Date()
                    item.put("takenAt", cursor.getLong(dateCol) * 1000L);
                    out.put(item);
                    n += 1;
                }
            }
            JSObject res = new JSObject();
            res.put("photos", out);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("翻不了相册：" + e.getMessage());
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    /**
     * 读出一张，缩到长边 1024 再转 base64。原图动辄十几 MB，不能直传。
     *
     * 注意 id 不能用 {@code call.getLong("id")}：Capacitor 的实现只认 JSON 解析出来是
     * Long 的值，而 JS 传来的小整数（MediaStore 的 id 通常小于 2^31）会落成 Integer，
     * 于是明明给了 id 也判成 null——第一版就栽在这，她连着两次「id 必须有」。
     */
    @PluginMethod
    public void read(PluginCall call) {
        Long id = asLong(call.getData().opt("id"));
        if (id == null) {
            call.reject("id 必须有");
            return;
        }
        try {
            Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream probe = getContext().getContentResolver().openInputStream(uri)) {
                BitmapFactory.decodeStream(probe, null, bounds);
            }
            int sample = 1;
            int longest = Math.max(bounds.outWidth, bounds.outHeight);
            while (longest / sample > MAX_SIDE) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bitmap;
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                bitmap = BitmapFactory.decodeStream(in, null, opts);
            }
            if (bitmap == null) {
                call.reject("这张图打不开");
                return;
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out);
            String b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            bitmap.recycle();

            JSObject res = new JSObject();
            res.put("data", "data:image/jpeg;base64," + b64);
            res.put("mediaType", "image/jpeg");
            res.put("width", bitmap.getWidth());
            res.put("height", bitmap.getHeight());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("读不了这张图：" + e.getMessage());
        }
    }
}
