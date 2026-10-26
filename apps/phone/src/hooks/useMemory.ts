import { useCallback, useRef, useState } from "react";
import type { DreamState, MemoryRecord } from "@herta/core";
import {
  buildPresenceNote,
  buildVoiceRevisionPrompt,
  cleanVoiceText,
  consolidateMemories,
  distillSession,
  extractJson,
  forgetMemories,
  runDreamPass,
  presenceAt,
  shouldConsolidate,
  shouldForget,
  timePhrase,
} from "@herta/core";
import type { Session } from "@herta/protocol";
import { BrowserAssetSource } from "../assets-browser.ts";
import { IdbMemoryStore } from "../memory-idb.ts";
import { loadPromptCode } from "../prompts.ts";
import type { Settings } from "../settings.ts";
import { collect } from "../stream.ts";
import { pickTransport } from "../transport.ts";

/**
 * 记忆的一切：库、做梦、消化、整理与遗忘、语气笔记。
 *
 * 从 App.tsx 里整块搬出来的。搬的时候只做了两件事：把 settings 变成入参、
 * 把「出错时告诉界面」变成 onError 回调。其余一行没改——顺序、闭包、依赖数组都原样，
 * 因为这一块最容易出「她记得上一轮的心情」那种难查的 bug。
 */
const assets = new BrowserAssetSource();
const transport = pickTransport();
const memoryStore = new IdbMemoryStore();

export function useMemory(settings: Settings, opts: { onError(message: string): void }) {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [dreamState, setDreamState] = useState<DreamState | null>(null);
  const [dreaming, setDreaming] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [distillNote, setDistillNote] = useState<string | null>(null);
  const [maintaining, setMaintaining] = useState<string | null>(null);
  const dreamingRef = useRef(false);
  const distillingRef = useRef(false);

  /** 从库里重新读一遍。启动时播种完、或者外部改了库之后调它。 */
  const refresh = useCallback(async () => {
    setMemories(await memoryStore.list());
    setDreamState(await memoryStore.state());
  }, []);

  const setError = (message: string) => opts.onError(message);
  const removeMemory = useCallback(async (name: string) => {
    await memoryStore.remove(name);
    setMemories(await memoryStore.list());
  }, []);

  /** 语气重写：读她最近的记忆，写一段「我说话是什么样」。做梦和消化共用这一个实现。 */
  const reviseVoiceImpl = useCallback(
    async (records: MemoryRecord[], previous: string | null) => {
      const { system, user } = buildVoiceRevisionPrompt(records, previous);
      const raw = await collect(
        transport.stream({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          maxTokens: 800,
        })
      );
      return cleanVoiceText(raw);
    },
    [settings.apiKey, settings.baseUrl, settings.model]
  );

  /**
   * 做梦。`force` 是手动点按钮时给的：绕过"材料够不够 / 隔了多久"两道门槛，
   * 但拦不住"值不值得记"——那道门是她自己的判断，不该被按钮跳过。
   */
  const dreamNow = useCallback(
    async (target: Session, force = false) => {
      if (dreamingRef.current || !settings.apiKey) return;
      if (!target.blocks.length) return;
      dreamingRef.current = true;
      setDreaming(true);
      try {
        const [promptAssets, code] = await Promise.all([assets.promptAssets(), loadPromptCode()]);
        const outcome = await runDreamPass(
          {
            store: memoryStore,
            prompts: code,
            scene: { env: buildPresenceNote(presenceAt(), timePhrase()), lang: "zh" },
        // 攒够记忆就让她重读自己、重写语气笔记——这是"语气会变"的唯一来源
        reviseVoice: reviseVoiceImpl,
            chat: ({ system, user, maxTokens }) =>
              collect(
                transport.stream({
                  apiKey: settings.apiKey,
                  baseUrl: settings.baseUrl,
                  model: settings.model,
                  messages: system
                    ? [
                        { role: "system", content: system },
                        { role: "user", content: user },
                      ]
                    : [{ role: "user", content: user }],
                  maxTokens,
                })
              ),
            now: () => Date.now(),
          },
          {
            sessionId: target.id,
            blocks: target.blocks,
            config: force ? { minNewBlocks: 2, minGapMs: 0 } : undefined,
          }
        );
        if (outcome.kind === "made") {
          setMemories(await memoryStore.list());
        }
        setDreamState(await memoryStore.state());
      } catch (e) {
        setError("做梦失败：" + (e instanceof Error ? e.message : String(e)));
      } finally {
        dreamingRef.current = false;
        setDreaming(false);
      }
    },
    [reviseVoiceImpl, settings.apiKey, settings.baseUrl, settings.model]
  );

  /**
   * 把一整段长对话消化成记忆。
   * 与做梦的区别：不问她"值不值得记"——你已经明确说了要记，那道门就不该拦。
   */
  const distillNow = useCallback(
    async (target: Session) => {
      if (distillingRef.current || !settings.apiKey) return;
      if (target.blocks.length < 12) {
        setDistillNote("这段太短了，直接点「让她做梦」就行。");
        return;
      }
      distillingRef.current = true;
      setDistilling(true);
      setDistillNote("开始整理…");
      try {
        const [promptAssets, code] = await Promise.all([assets.promptAssets(), loadPromptCode()]);
        const chunks = Math.min(12, Math.max(2, Math.round(target.blocks.length / 40)));
        const out = await distillSession(
          {
            store: memoryStore,
            prompts: code,
            scene: { env: buildPresenceNote(presenceAt(), timePhrase()), lang: "zh" },
            chat: ({ system, user, maxTokens }) =>
              collect(
                transport.stream({
                  apiKey: settings.apiKey,
                  baseUrl: settings.baseUrl,
                  model: settings.model,
                  messages: system
                    ? [
                        { role: "system", content: system },
                        { role: "user", content: user },
                      ]
                    : [{ role: "user", content: user }],
                  maxTokens,
                })
              ),
            now: () => Date.now(),
            reviseVoice: reviseVoiceImpl,
          },
          {
            sessionId: target.id,
            blocks: target.blocks,
            config: { chunks, minBlocksPerChunk: 6 },
          },
          (done, total, note) => setDistillNote(note + "（" + done + "/" + total + "）")
        );
        setMemories(await memoryStore.list());
        setDreamState(await memoryStore.state());
        setDistillNote(
          "整理完了：写了 " +
            out.made.length +
            " 则记忆" +
            (out.failed ? "，" + out.failed + " 段没写成" : "") +
            (out.voiceUpdated ? "，语气笔记也重写了" : "")
        );
      } catch (e) {
        setDistillNote("没整理成：" + (e instanceof Error ? e.message : String(e)));
      } finally {
        distillingRef.current = false;
        setDistilling(false);
      }
    },
    [reviseVoiceImpl, settings.apiKey, settings.baseUrl, settings.model]
  );

  /**
   * 记忆的日常维护：到 20 条整理一次（关联 / 简化 / 加深），到 50 条忘掉最轻的 10 条。
   * 两个动作都只在跨过阈值时发生，平时什么都不做。
   */
  const maintainMemories = useCallback(async () => {
    if (maintaining) return;
    try {
      const state = await memoryStore.state();
      const records = await memoryStore.list();
      const active = records.filter((r) => !r.forgotten);

      if (shouldForget(active.length)) {
        setMaintaining("记忆太多了，正在忘掉最轻的十条…");
        const victims = await forgetMemories(memoryStore, Date.now());
        const st = await memoryStore.state();
        await memoryStore.saveState({
          ...st,
          forgottenTotal: (st.forgottenTotal ?? 0) + victims.length,
          lastNote: "忘掉了 " + victims.length + " 条（最轻的）",
        });
      }

      const latest = await memoryStore.state();
      if (shouldConsolidate(active.length, latest.lastConsolidatedCount ?? null)) {
        setMaintaining("记忆攒到 " + active.length + " 条了，正在整理…");
        const code = await loadPromptCode();
        const out = await consolidateMemories(
          {
            store: memoryStore,
            chat: ({ system, user, maxTokens }) =>
              collect(
                transport.stream({
                  apiKey: settings.apiKey,
                  baseUrl: settings.baseUrl,
                  model: settings.model,
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                  maxTokens,
                })
              ),
            now: () => Date.now(),
          },
          extractJson
        );
        const st = await memoryStore.state();
        await memoryStore.saveState({
          ...st,
          lastConsolidatedCount: active.length,
          lastNote: "整理了 " + out.touched + " 条：" + out.plan.links.length + " 条关联，" +
            out.plan.simplify.length + " 条简化，" + out.plan.deepen.length + " 条加深",
        });
      }

      setMemories(await memoryStore.list());
      setDreamState(await memoryStore.state());
    } catch (e) {
      setDistillNote("记忆维护没做完：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setMaintaining(null);
    }
  }, [maintaining, settings.apiKey, settings.baseUrl, settings.model]);

  return {
    memories,
    dreamState,
    dreaming,
    distilling,
    distillNote,
    maintaining,
    refresh,
    removeMemory,
    dreamNow,
    distillNow,
    maintainMemories,
    reviseVoiceImpl,
  };
}
