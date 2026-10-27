package com.personacli.herta.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.util.Base64;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * HertaHttp —— 手机端的"原生 HTTP 通道"。
 *
 * 为什么必须有它：WebView 的 origin 是 https://localhost，api.deepseek.com
 * 如果不回 Access-Control-Allow-Origin，页面里的 fetch 会被直接掐掉。
 * 走原生 HTTP 就没有 CORS 这回事——同源策略只在浏览器进程里生效。
 *
 * 为什么用 HttpURLConnection 而不是 OkHttp：Capacitor 的 android 包没有把 okhttp
 * 暴露到 compile classpath（第一版照 OkHttp 写，编译期直接报"程序包 okhttp3 不存在"）。
 * 为一行流式读取再引一个外部依赖不值得；系统自带的这层够用，也不增加 APK 体积。
 *
 * 语义：
 *   stream(requestId, url, headers, body)
 *     → 响应头到手就 resolve({status})，之后靠事件推回数据：
 *       notifyListeners("chunk", { requestId, data })      一批原始文本（按 SSE 空行切块）
 *       notifyListeners("chunk", { requestId, done: true }) 结束
 *       notifyListeners("chunk", { requestId, error })      出错
 *   cancel(requestId) → 断开连接
 */
@CapacitorPlugin(name = "HertaHttp")
public class HertaHttpPlugin extends Plugin {

    private final Map<String, HttpURLConnection> inflight = new ConcurrentHashMap<>();

    @PluginMethod
    public void stream(PluginCall call) {
        final String requestId = call.getString("requestId");
        final String url = call.getString("url");
        final JSObject headers = call.getObject("headers", new JSObject());
        final String body = call.getString("body", "{}");

        if (requestId == null || url == null) {
            call.reject("requestId 与 url 必须有");
            return;
        }

        new Thread(() -> {
            HttpURLConnection conn = null;
            boolean resolved = false;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setConnectTimeout(30_000);
                conn.setReadTimeout(180_000);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");

                if (headers != null) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        conn.setRequestProperty(k, headers.getString(k));
                    }
                }

                inflight.put(requestId, conn);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }

                int status = conn.getResponseCode();

                JSObject head = new JSObject();
                head.put("status", status);
                call.resolve(head);
                resolved = true;

                if (status >= 400) {
                    String detail = readAll(conn.getErrorStream(), 2000);
                    if (detail != null && !detail.isEmpty()) emit(requestId, detail);
                    emitDone(requestId, "HTTP " + status);
                    return;
                }

                InputStream is = conn.getInputStream();
                if (is == null) {
                    emitDone(requestId, null);
                    return;
                }

                BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                StringBuilder buf = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    buf.append(line).append('\n');
                    // SSE 以空行分帧：切在这里，JS 那边就不会拿到半截 JSON。
                    if (line.isEmpty()) {
                        emit(requestId, buf.toString());
                        buf.setLength(0);
                    }
                }
                if (buf.length() > 0) emit(requestId, buf.toString());
                emitDone(requestId, null);
            } catch (Exception e) {
                if (!resolved) {
                    call.reject(String.valueOf(e.getMessage()));
                } else {
                    emitDone(requestId, String.valueOf(e.getMessage()));
                }
            } finally {
                inflight.remove(requestId);
                if (conn != null) conn.disconnect();
            }
        }, "herta-http").start();
    }

    /**
     * 一次性的 GET，整段拿回来（不流式）。
     * 用来取分享页的数据接口：`/api/v0/share/content?share_id=…`，
     * 那是公开接口、不需要登录态，踩不到 CORS。
     */
    @PluginMethod
    public void get(PluginCall call) {
        final String url = call.getString("url");
        if (url == null) {
            call.reject("url 必须有");
            return;
        }
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(20_000);
                conn.setReadTimeout(90_000);
                conn.setRequestProperty("Accept", "application/json");

                int status = conn.getResponseCode();
                String body = readAll(status >= 400 ? conn.getErrorStream() : conn.getInputStream(), 16_000_000);

                JSObject o = new JSObject();
                o.put("status", status);
                o.put("body", body == null ? "" : body);
                call.resolve(o);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, "herta-http-get").start();
    }

    /**
     * 一次性 POST，整段拿回来（不流式）。
     * 搜索接口（/v1/tools/search）是 POST + JSON，用不了流式那条路。
     */
    @PluginMethod
    public void post(PluginCall call) {
        final String url = call.getString("url");
        final JSObject headers = call.getObject("headers", new JSObject());
        final String body = call.getString("body", "{}");
        if (url == null) {
            call.reject("url 必须有");
            return;
        }
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setConnectTimeout(20_000);
                conn.setReadTimeout(90_000);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");

                if (headers != null) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        conn.setRequestProperty(k, headers.getString(k));
                    }
                }

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }

                int status = conn.getResponseCode();
                String text = readAll(status >= 400 ? conn.getErrorStream() : conn.getInputStream(), 16_000_000);

                JSObject o = new JSObject();
                o.put("status", status);
                o.put("body", text == null ? "" : text);
                call.resolve(o);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, "herta-http-post").start();
    }

    /**
     * POST，拿**二进制**响应（语音合成返回的是 mp3）。
     * readAll 是按 UTF-8 读文本的，音频经它一过就废了——所以单开一条，回 base64。
     */
    @PluginMethod
    public void postBinary(PluginCall call) {
        final String url = call.getString("url");
        final JSObject headers = call.getObject("headers", new JSObject());
        final String body = call.getString("body", "{}");
        if (url == null) {
            call.reject("url 必须有");
            return;
        }
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setConnectTimeout(20_000);
                conn.setReadTimeout(180_000);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");

                if (headers != null) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        conn.setRequestProperty(k, headers.getString(k));
                    }
                }

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }

                int status = conn.getResponseCode();
                InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                if (is != null) {
                    byte[] chunk = new byte[16384];
                    int n;
                    while ((n = is.read(chunk)) > 0) buf.write(chunk, 0, n);
                }

                JSObject o = new JSObject();
                o.put("status", status);
                o.put("base64", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
                String ct = conn.getContentType();
                o.put("mediaType", ct == null ? "audio/mpeg" : ct);
                call.resolve(o);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, "herta-http-bin").start();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String requestId = call.getString("requestId");
        HttpURLConnection conn = requestId == null ? null : inflight.remove(requestId);
        if (conn != null) conn.disconnect();
        call.resolve();
    }

    private static String readAll(InputStream is, int cap) {
        if (is == null) return null;
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null && sb.length() < cap) {
                sb.append(line).append('\n');
            }
        } catch (Exception ignored) {
            // 错误流读不到就只报状态码
        }
        return sb.toString();
    }

    /**
     * notifyListeners 最终会走到 WebView.evaluateJavascript，那是 UI 线程的事。
     * 我们在读取网络的后台线程里，所以统一 post 回主线程——顺序由主 looper 的队列保证，
     * 块与块的先后不会乱。
     */
    private void post(Runnable r) {
        android.app.Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(r);
        } else {
            r.run();
        }
    }

    private void emit(final String requestId, final String data) {
        final JSObject o = new JSObject();
        o.put("requestId", requestId);
        o.put("data", data);
        post(() -> notifyListeners("chunk", o));
    }

    private void emitDone(final String requestId, final String error) {
        final JSObject o = new JSObject();
        o.put("requestId", requestId);
        o.put("done", true);
        if (error != null) o.put("error", error);
        post(() -> notifyListeners("chunk", o));
    }

    @Override
    protected void handleOnDestroy() {
        for (HttpURLConnection c : inflight.values()) c.disconnect();
        inflight.clear();
        super.handleOnDestroy();
    }
}
