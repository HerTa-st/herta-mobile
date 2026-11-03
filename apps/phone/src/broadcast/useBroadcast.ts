/**
 * 播报的状态机：今天有没有期 / 生成 / 缓存 / 失败 / 已读。
 *
 * 挂在 App 上（不是播报页里）：所以就算你从没点开过播报页，08:00 后第一次打开 app
 * 也会先把今天这一期做出来，再把「播报提示」写进当时的会话。
 *
 * 设计文档：docs/设计-星际和平播报-v1.md（决策 3/4/9/12/13/14/15）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildBroadcastIssue,
  localDateId,
  nextIssueNo,
  type BroadcastIssue,
} from "@herta/core";
import type { Settings } from "../settings.ts";
import { generateBroadcast } from "./generate.ts";
import { readArticle } from "./reader.ts";
import { syncBroadcastReminder } from "./notify.ts";
import {
  DEFAULT_BROADCAST_CONFIG,
  clearBroadcastIssues,
  listBroadcastIssues,
  loadBroadcastCleared,
  loadBroadcastConfig,
  loadReadNo,
  markBroadcastCleared,
  markPrompted,
  promptedIssueId,
  saveBroadcastConfig,
  saveBroadcastIssue,
  saveReadNo,
  type BroadcastConfig,
} from "./storage.ts";

export type BroadcastStatus = "idle" | "before" | "loading" | "ready" | "failed";

export interface UseBroadcastResult {
  issues: BroadcastIssue[];
  today: BroadcastIssue | null;
  status: BroadcastStatus;
  error: string | null;
  generating: boolean;
  config: BroadcastConfig;
  unread: boolean;
  refresh(): Promise<void>;
  generate(force?: boolean): Promise<void>;
  markRead(): Promise<void>;
  /** 读原文的稿子存回这一期（下次点开直接用，不再花一次模型调用）。 */
  cacheDetail(issueId: string, itemId: string, digest: { points: string[]; detail: string }): Promise<void>;
  updateConfig(next: BroadcastConfig): Promise<void>;
  clearHistory(): Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAfterBroadcastHour(now = new Date()): boolean {
  return now.getHours() >= 8;
}

function findToday(issues: readonly BroadcastIssue[]): BroadcastIssue | null {
  const id = localDateId();
  return issues.find((issue) => issue.id === id) ?? null;
}

export function useBroadcast(opts: {
  settings: Settings;
  /** 开屏结束后再跑，别和启动抢资源。 */
  enabled: boolean;
  /** 今天这一期好了，但还没在聊天里递过：App 负责写「播报提示」。 */
  onPrompt(issue: BroadcastIssue): Promise<void> | void;
}): UseBroadcastResult {
  const [issues, setIssues] = useState<BroadcastIssue[]>([]);
  const [today, setToday] = useState<BroadcastIssue | null>(null);
  const [status, setStatus] = useState<BroadcastStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<BroadcastConfig>(DEFAULT_BROADCAST_CONFIG);
  const [readNo, setReadNo] = useState(0);
  const [generating, setGenerating] = useState(false);

  const settingsRef = useRef(opts.settings);
  settingsRef.current = opts.settings;
  const onPromptRef = useRef(opts.onPrompt);
  onPromptRef.current = opts.onPrompt;

  const issuesRef = useRef<BroadcastIssue[]>([]);
  const todayRef = useRef<BroadcastIssue | null>(null);
  const configRef = useRef<BroadcastConfig>(DEFAULT_BROADCAST_CONFIG);
  const readNoRef = useRef(0);
  const clearedRef = useRef("");
  const inflightRef = useRef(false);
  /** 上一次生成失败的时间：自动路径 10 分钟内不再重试，免得每分钟烧一次搜索/模型。 */
  const lastFailureRef = useRef(0);

  const applyIssues = useCallback((next: BroadcastIssue[]) => {
    issuesRef.current = next;
    setIssues(next);
    const currentToday = findToday(next);
    todayRef.current = currentToday;
    setToday(currentToday);
    if (currentToday) setStatus("ready");
    return currentToday;
  }, []);

  const rememberRead = useCallback((no: number) => {
    readNoRef.current = no;
    setReadNo(no);
  }, []);

  /**
   * 把「播报提示」写进聊天。
   *
   * 单独抽出来：生成成功时要写，app 重新打开时也要补写（上次可能在聊天中、
   * 或者进程被杀掉了）。同一天写成功一次就记 prompted，不会重复。
   */
  const deliverPrompt = useCallback(async (issue: BroadcastIssue) => {
    try {
      if ((await promptedIssueId()) === issue.id) return;
      await onPromptRef.current(issue);
      await markPrompted(issue.id);
    } catch (promptError) {
      // 她正在说话 / 还没有会话 / IndexedDB 抽风：下一分钟或下次打开再补，别把这一期算失败
      console.warn("播报提示没写进对话：", promptError);
    }
  }, []);

  /** 读好的稿子存回这一期（下次点开直接用，不再花一次模型调用）。 */
  const cacheDetail = useCallback(
    async (issueId: string, itemId: string, digest: { points: string[]; detail: string }) => {
      const current = issuesRef.current.find((issue) => issue.id === issueId);
      if (!current || current.items.every((item) => item.id !== itemId)) return;
      const next: BroadcastIssue = {
        ...current,
        items: current.items.map((item) => (item.id === itemId ? { ...item, ...digest } : item)),
      };
      try {
        await saveBroadcastIssue(next);
        applyIssues(issuesRef.current.map((issue) => (issue.id === issueId ? next : issue)));
      } catch {
        // 存不上最多下次再读一遍；不能让阅读页因为落盘失败而崩掉
      }
    },
    [applyIssues]
  );

  /**
   * 一期落地后，后台把每条的原文读成稿子（桌面信息流的 detail 阶段）。
   *
   * 摆在前台做的话，正文要等五六次抓取 + 模型调用；先让她把一期递出去，
   * 稿子在后台一条条补上，点开时能看就直接看。读失败的那条留着手动再读。
   */
  const prefetchDetails = useCallback(
    async (issue: BroadcastIssue) => {
      const settings = settingsRef.current;
      if (!settings.apiKey) return;
      const targets = issue.items.filter((item) => !item.egg && item.url && !item.detail).slice(0, 5);
      for (const item of targets) {
        try {
          const digest = await readArticle(item, settings);
          await cacheDetail(issue.id, item.id, digest);
        } catch {
          // 抓不到就等用户点开时再试，不影响这一期已经存在
        }
      }
    },
    [cacheDetail]
  );

  const load = useCallback(async () => {
    const [nextIssues, nextConfig, storedReadNo, cleared] = await Promise.all([
      listBroadcastIssues(),
      loadBroadcastConfig(),
      loadReadNo(),
      loadBroadcastCleared(),
    ]);
    configRef.current = nextConfig;
    setConfig(nextConfig);
    rememberRead(storedReadNo);
    clearedRef.current = cleared;
    const currentToday = applyIssues(nextIssues);
    if (currentToday) void deliverPrompt(currentToday);
  }, [applyIssues, deliverPrompt, rememberRead]);

  const generate = useCallback(
    async (force = false) => {
      if (inflightRef.current) return;
      const settings = settingsRef.current;
      if (!settings.apiKey) {
        setStatus("failed");
        setError("先在设置里填 API Key。");
        return;
      }
      // 今天已经有一期就不重复做；跨过午夜后 todayRef 还是昨天，要允许做新的一期
      if (!force && todayRef.current?.id === localDateId()) return;

      inflightRef.current = true;
      setGenerating(true);
      setStatus("loading");
      setError(null);
      try {
        const result = await generateBroadcast({
          settings,
          tags: configRef.current.tags,
        });
        const date = localDateId();
        const issue = buildBroadcastIssue({
          date,
          no: nextIssueNo(issuesRef.current),
          items: result.items,
        });
        await saveBroadcastIssue(issue);
        clearedRef.current = "";
        const next: BroadcastIssue[] = [issue, ...issuesRef.current.filter((i) => i.id !== issue.id)].sort(
          (a, b) => b.no - a.no
        );
        applyIssues(next);
        lastFailureRef.current = 0;
        await deliverPrompt(issue);
        void prefetchDetails(issue);
      } catch (generateError) {
        lastFailureRef.current = Date.now();
        setStatus("failed");
        setError(errorText(generateError));
      } finally {
        inflightRef.current = false;
        setGenerating(false);
      }
    },
    [applyIssues, deliverPrompt, prefetchDetails]
  );

  /* 启动：读库 → 看今天有没有期；没有且过了 08:00 就做 */
  useEffect(() => {
    if (!opts.enabled) return;
    let alive = true;
    void (async () => {
      try {
        await load();
        if (!alive) return;
        if (todayRef.current) return;
        if (clearedRef.current === localDateId()) {
          setStatus("idle");
          return;
        }
        if (!isAfterBroadcastHour()) {
          setStatus("before");
          return;
        }
        await generate(false);
      } catch (loadError) {
        if (alive) {
          setStatus("failed");
          setError(errorText(loadError));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [opts.enabled, load, generate]);

  /* 前台每分钟看一眼：跨过 08:00 / 跨过午夜 / 从别的 app 回来 / 补递提示 */
  useEffect(() => {
    if (!opts.enabled) return;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      const current = todayRef.current;
      if (current && current.id === localDateId()) {
        void deliverPrompt(current);
        return;
      }
      if (inflightRef.current) return;
      if (!current && clearedRef.current === localDateId()) {
        setStatus("idle");
        return;
      }
      if (!isAfterBroadcastHour()) {
        if (!current) setStatus("before");
        return;
      }
      // 失败后的自动重试要冷却；手动「重试 / 来一期」走 generate(true)，不受这里限制
      if (Date.now() - lastFailureRef.current < 10 * 60_000) return;
      void generate(false);
    };
    const timer = window.setInterval(check, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [opts.enabled, deliverPrompt, generate]);

  const markRead = useCallback(async () => {
    const current = todayRef.current;
    if (!current) return;
    if (readNoRef.current >= current.no) return;
    try {
      await saveReadNo(current.no);
      rememberRead(current.no);
    } catch {
      /* 已读状态存不上不影响看播报 */
    }
  }, [rememberRead]);

  const updateConfig = useCallback(async (next: BroadcastConfig) => {
    try {
      const saved = await saveBroadcastConfig(next);
      configRef.current = saved;
      setConfig(saved);
      await syncBroadcastReminder();
    } catch (configError) {
      console.warn("播报配置没存上：", configError);
    }
  }, []);

  const clearHistory = useCallback(async () => {
    const date = localDateId();
    try {
      await clearBroadcastIssues();
      await markBroadcastCleared(date);
      clearedRef.current = date;
      issuesRef.current = [];
      todayRef.current = null;
      setIssues([]);
      setToday(null);
      rememberRead(0);
      setStatus("idle");
      setError(null);
    } catch (clearError) {
      console.warn("播报历史没清掉：", clearError);
    }
  }, [rememberRead]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const unread = useMemo(() => {
    return today !== null && today.no > readNo;
  }, [today, readNo]);

  return {
    issues,
    today,
    status,
    error,
    generating,
    config,
    unread,
    refresh,
    generate,
    markRead,
    cacheDetail,
    updateConfig,
    clearHistory,
  };
}
