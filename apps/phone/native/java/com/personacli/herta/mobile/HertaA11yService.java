package com.personacli.herta.mobile;

import android.accessibilityservice.AccessibilityService;
import android.content.SharedPreferences;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.List;

/**
 * 无障碍：看清屏幕上有什么，按文字点一下。
 *
 * 边界写在三个地方，缺一条都不算数：
 *   1. 只在白名单里的 App 生效（设置页里逐个勾，存在 SharedPreferences）；
 *   2. 动手之前她在对话里先问一句（这是人格层的规矩，不是代码）；
 *   3. 只做两件事——读当前窗口的文字、按文字点一个可点的节点。没有手势、没有输入、
 *      不监听输入框，也不读密码框（能点 ≠ 能读内容）。
 *
 * 为什么读的是"当前窗口"而不是持续快照：她要的是"这个页面写了什么"，
 * 不是"你这一整天点了什么"。持续收集通知栏那件事已经够重了。
 */
public class HertaA11yService extends AccessibilityService {

    public static final String PREFS = "herta_a11y";
    public static final String KEY_WHITELIST = "whitelist";

    private static HertaA11yService instance;

    public static HertaA11yService get() {
        return instance;
    }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // 不做实时反应：每次请求都现读一次窗口
    }

    @Override
    public void onInterrupt() {
        // 用户或系统打断；下一次请求会自己重新读
    }

    /** 白名单。空 = 一个都不许。 */
    public List<String> whitelist() {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        String raw = sp.getString(KEY_WHITELIST, "");
        List<String> out = new ArrayList<>();
        if (raw == null || raw.trim().isEmpty()) return out;
        for (String p : raw.split(",")) {
            if (!p.trim().isEmpty()) out.add(p.trim());
        }
        return out;
    }

    public boolean allowed(String pkg) {
        return pkg != null && whitelist().contains(pkg);
    }

    /** 当前窗口说明是哪个 App 的。 */
    public String currentPackage() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "";
        CharSequence p = root.getPackageName();
        return p == null ? "" : p.toString();
    }

    /**
     * 把当前窗口里的文字按阅读顺序摊平。
     *
     * 只收有字的节点，去重；每条带一个"可点"标记——这样她说"帮你点"的时候，
     * 点的是她刚刚看见过的那一行，而不是猜出来的。
     */
    public List<String> snapshot(int max) {
        List<String> out = new ArrayList<>();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return out;
        walk(root, out, max);
        return out;
    }

    private void walk(AccessibilityNodeInfo node, List<String> out, int max) {
        if (node == null || out.size() >= max) return;
        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        String line = text != null && text.length() > 0 ? text.toString() : (desc == null ? "" : desc.toString());
        line = line.replaceAll("\\s+", " ").trim();
        if (!line.isEmpty()) {
            String row = (node.isClickable() ? "▸ " : "  ") + (line.length() > 80 ? line.substring(0, 80) + "…" : line);
            if (!out.contains(row)) out.add(row);
        }
        for (int i = 0; i < node.getChildCount() && out.size() < max; i += 1) {
            walk(node.getChild(i), out, max);
        }
    }

    /** 按文字点一下。找不到、或者不可点，都返回一句能说给人听的话。 */
    public String tap(String needle) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "没读到屏幕。";
        AccessibilityNodeInfo hit = find(root, needle);
        if (hit == null) return "屏幕上没有「" + needle + "」。";
        AccessibilityNodeInfo clickable = hit;
        while (clickable != null && !clickable.isClickable()) {
            clickable = clickable.getParent();
        }
        if (clickable == null) return "「" + needle + "」不是一个能点的东西。";
        clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        return "点了「" + needle + "」。";
    }

    private AccessibilityNodeInfo find(AccessibilityNodeInfo node, String needle) {
        if (node == null) return null;
        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        String line = text != null ? text.toString() : (desc == null ? "" : desc.toString());
        if (line != null && line.contains(needle)) return node;
        for (int i = 0; i < node.getChildCount(); i += 1) {
            AccessibilityNodeInfo got = find(node.getChild(i), needle);
            if (got != null) return got;
        }
        return null;
    }
}
