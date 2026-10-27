import { useCallback, useEffect, useRef, useState } from "react";
import type { Block, ChatPart, Session } from "@herta/protocol";
import {
  DEFAULT_MOOD,
  REVIEW_POLICY,
  appendBlocks,
  buildMoodPrompt,
  buildPresenceNote,
  buildReviewMessages,
  buildStaticPrefix,
  decideReview,
  decideMood,
  moodStyleNote,
  parseMoodVerdict,
  parseNarrative,
  parseSupervisorVerdict,
  pickSeeds,
  presenceAt,
  addUsage,
  emptyUsage,
  runToolLoop,
  serializeRecord,
  timePhrase,
  trimForContext,
  vetoHints,
  voiceTextOf,
  type ChatMessage,
  type DreamState,
  type MemoryRecord,
  type MoodState,
} from "@herta/core";
import { BrowserAssetSource } from "../assets-browser.ts";
import { captionImage } from "../vision.ts";
import { buildTools } from "../devtools.ts";
import { loadMoodState, saveMoodState, type StickerRecord } from "../storage.ts";
import { loadPromptCode } from "../prompts.ts";
import { budgetOf, type Settings } from "../settings.ts";
import { collectDetailed } from "../stream.ts";
import { pickTransport } from "../transport.ts";

const assets = new BrowserAssetSource();
const transport = pickTransport();

/** 工具名 → 说人话的标签，给聊天里的系统性提示用。 */
const TOOL_LABEL: Record<string, string> = {
  now: "看了时间",
  clipboard: "动了剪贴板",
  calc: "算了一下",
  web_search: "上网查了",
  device: "看了手机状态",
  read_file: "读了文件",
  sticker: "翻出一张表情",
  keep_sticker: "收下了那张表情",
  remind: "设了个提醒",
  reminders: "看了自己的提醒",
  cancel_reminder: "撤了一条提醒",
  calendar: "看了日历",
  add_event: "写进日历了",
  phone_status: "看了手机状态",
  open: "打开了东西",
  share: "调出了分享面板",
  plan_ping: "排了下次找你的时间",
  where_am_i: "看了你在哪",
  look_through_camera: "拍了张照",
};

/**
 * 一个回合：判心情 → 算行踪 → 带工具说话 → 她自己复核 → 落库。
 *
 * 从 App.tsx 整块搬来的。改过的只有三处：text 变成入参、setError 变成 onError 回调、
 * busy/mood/abort 三处状态搬进这里。其余顺序、闭包与依赖数组原样保留——
 * 这一块一旦错一个捕获，表现是"她记得上一轮的心情"，你根本不会去查依赖数组。
 */
export function useChatTurn(opts: {
  settings: Settings;
  session: Session | null;
  setSession(next: Session): void;
  persist(session: Session): Promise<void>;
  memories: MemoryRecord[];
  dreamState: DreamState | null;
  files: Map<string, string>;
  stickers: StickerRecord[];
  /** 她把你的表情收进库时：落库并刷新列表。 */
  onKeepSticker(record: StickerRecord): void;
  onError(message: string | null): void;
  onNeedKey(): void;
}) {
  const { settings, session, setSession, persist, memories, dreamState, files, stickers, onKeepSticker, onError, onNeedKey } = opts;
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState<string>(DEFAULT_MOOD);
  // 打开 App 时把上次的心情接上；超过三小时 loadMoodState 会返回 null，就当没有
  useEffect(() => {
    let alive = true;
    void loadMoodState()
      .then((s) => {
        if (alive && s) setMood(s.mood);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const abort = useRef<AbortController | null>(null);
  const send = useCallback(async (
    text: string,
    attachments?: { mediaType: string; data: string; name?: string }[],
    /** 这一轮是"发了一张表情"：那么起点不是一条文字消息，而是表情块。 */
    sticker?: StickerRecord
  ) => {
    if ((!text.trim() && !attachments?.length && !sticker) || busy || !session) return;
    if (!settings.apiKey) {
      onError("先填 API Key。她不会替你保管，只存在这台手机上。");
      onNeedKey();
      return;
    }
    onError(null);
    setBusy(true);
    

    const at = new Date().toISOString();
    // 发一张表情和发一条文字是两种起点：表情块没有台词，但它同样"是你开的口"，
    // 序列化、截断、撤回都按这个认（见 core/sticker.ts）。
    const opening: Block = sticker
      ? { kind: "sticker", from: "user", stickerId: sticker.id, name: sticker.name, at }
      : {
          kind: "user",
          text,
          at,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        };
    const history = appendBlocks(session, [opening]);
    setSession(history);
    void persist(history);

    const ctl = new AbortController();
    abort.current = ctl;

    const base = {
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      signal: ctl.signal,
    };
    // 这一轮实际能花多少：省 token 开关在 core 里换算成具体数字，别在两处各写一遍
    const budget = budgetOf(settings);

    let raw = "";
    /** 这一轮花掉的 token：判心情、主对话（含工具轮）、复核、重说，全加进来。 */
    let spent = emptyUsage();
    try {
      const promptAssets = await assets.promptAssets();
      // 这一轮用哪几篇记忆：开局定死，想 / 说 / 复核共用同一批（否则三趟看到的她不一样）。
      const pool = memories.map((m) => ({ file: m.name, body: m.body }));
      const seeds = pickSeeds(pool, text, budget.memorySeeds);
      const context = trimForContext(history.blocks, budget.contextBlocks);

      // 先判心情：一次十几个 token 的调用，换来她这一轮的语气基线不一样。
      // 但心情不是每轮重抽的：把她现在的状态一起交下去，只有踩到雷区/好感区才换档；
      // 判定失败就沿用上一轮——心情不该成为整轮对话的单点故障，更不该把她重置成默认。
      let thisMood = DEFAULT_MOOD;
      if (budget.mood) {
        let previous: MoodState | null = null;
        try {
          previous = await loadMoodState();
        } catch {
          previous = null; // 读不到就当没有历史，不挡这一轮
        }
        thisMood = previous?.mood ?? DEFAULT_MOOD;
        try {
          const pack = await assets.mood();
          if (pack) {
            const p = buildMoodPrompt(
              pack,
              serializeRecord(trimForContext(history.blocks, 12), { maxBlocks: 0 }),
              previous?.mood ?? null
            );
            const seen = await collectDetailed(
              transport.stream({
                ...base,
                messages: [
                  { role: "system", content: p.system },
                  { role: "user", content: p.user },
                ],
                maxTokens: 12,
              })
            );
            spent = addUsage(spent, seen.usage);
            const decision = decideMood(previous, parseMoodVerdict(seen.text, pack.moods), Date.now(), {
              volatile: pack.volatile,
            });
            thisMood = decision.mood;
            // 落盘不挡这一轮：写失败最多是下次少一点惯性
            void saveMoodState(decision.state).catch(() => undefined);
          }
        } catch {
          /* 判不出来就保持上一轮 */
        }
        setMood(thisMood);
      }

      const styleNote = budget.mood ? moodStyleNote(promptAssets, thisMood) : null;
      // 她此刻在哪：按钟点算，同一天同一时段固定，隔天才换。
      const presenceNote = buildPresenceNote(presenceAt(), timePhrase());
      const prefix = buildStaticPrefix({
        assets: promptAssets,
        seeds,
        voiceText: voiceTextOf(dreamState),
        presence: presenceNote,
        extraNotes: styleNote ? ["〔旁注：" + styleNote + "〕"] : [],
      });
      const transcript = serializeRecord(context, { maxBlocks: 0 });
      /**
       * 图直接给模型看。
       *
       * DeepSeek 的 deepseek-flash 收 OpenAI 形状的 image_url 片段（官方「图像理解」文档），
       * 以前那句「对话模型不吃图片」已经不成立——老路子是先用另一个视觉模型写成文字，
       * 多一次调用、还丢掉细节。这里只带**这一轮**的图：历史轮的图不重复寄，
       * 转录里那一行「（附了一张图）」够她把话接上。
       */
      // 表情也让她看见：光给一行标签，她回的话常常和梗对不上。
      // 一张表情按单图预算算（约 1024 token），比一次工具轮便宜。
      const pictures: ChatPart[] = sticker
        ? [{ type: "image_url", image_url: { url: sticker.data } }]
        : (attachments ?? []).map((a) => ({
            type: "image_url",
            image_url: { url: a.data },
          }));
      const systemMessage: ChatMessage = { role: "system", content: prefix };
      /** 这一轮真正发出去的形状。模型不收图时会换成纯文字那份——复核重说也得跟着换。 */
      let messages: ChatMessage[] = [
        systemMessage,
        // 已经按整轮边界截过了，序列化层不要再截一次——那会从她话中间切开。
        {
          role: "user",
          content: pictures.length > 0 ? [{ type: "text", text: transcript }, ...pictures] : transcript,
        },
      ];

      // 她这一轮挑中的表情：工具里回调出来，最后贴到她那句话上
      let pickedSticker: StickerRecord | null = null;
      // 带上她的手：查时间、搜网、算一段、读文件，以及发表情
      const tools = buildTools({
        transport,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        files,
        // 只有她的库：你的箱不该参与"她挑一张发出去"
        stickers: stickers.filter((s) => s.owner !== "mine"),
        visionModel: settings.visionModel,
        albumEnabled: settings.albumEnabled,
        onSticker: (record) => {
          pickedSticker = record;
        },
        currentSticker: sticker ?? null,
        onKeepSticker: (record) => onKeepSticker(record),
        system: {
          reminders: settings.remindersEnabled,
          calendar: settings.calendarEnabled,
          status: settings.statusEnabled,
          open: settings.openEnabled,
          share: settings.shareEnabled,
          location: settings.locationEnabled,
          camera: settings.cameraEnabled && Boolean(settings.visionModel),
          proactive: settings.proactiveEnabled && !settings.cheapMode,
          describePhoto: settings.visionModel
            ? (dataUrl) =>
                captionImage(
                  transport,
                  { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.visionModel },
                  dataUrl,
                  "这是他刚用相机拍的一张"
                )
            : undefined,
        },
        cheap: settings.cheapMode,
      });
      const toolNotes: Block[] = [];

      const startLoop = (seed: readonly ChatMessage[]) =>
        runToolLoop(
          {
            tools,
            maxRounds: budget.toolRounds,
            // 写类单算：一轮最多动三次手（见 core/tools.ts）
            maxWrites: 3,
            stream: (r) =>
              transport.stream({
                apiKey: settings.apiKey,
                baseUrl: settings.baseUrl,
                model: settings.model,
                messages: r.messages,
                tools: r.tools,
                maxTokens: r.maxTokens,
                signal: ctl.signal,
              }),
            onText: (piece) => {
              raw += piece;
              const live = parseNarrative(raw).speech;
              if (!live) return;
              setSession({
                ...history,
                blocks: [
                  ...history.blocks,
                  ...toolNotes,
                  { kind: "herta", surface: "speech", text: live, at: new Date().toISOString() },
                ],
              });
            },
            onToolResult: (result) => {
              const note: Block = {
                kind: "system",
                label: "系统",
                body:
                  "（" +
                  (TOOL_LABEL[result.name] ?? "用了 " + result.name) +
                  "：" +
                  String(result.content).replace(/\s+/g, " ").slice(0, 140) +
                  "）",
                at: new Date().toISOString(),
              };
              toolNotes.push(note);
              setSession({ ...history, blocks: [...history.blocks, ...toolNotes] });
            },
          },
          seed
        );

      let loop;
      try {
        loop = await startLoop(messages);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        // 模型不收图（deepseek-v4-pro、或中转站没开视觉）时别让整轮报废：
        // 退回纯文字再审一遍，并明说这一轮她只看到字。401/429 之类照旧抛出去。
        // 已经吐过字就说明第一轮过了，别再重跑——那会把半句话接成两遍。
        if (pictures.length === 0 || raw !== "" || !/模型接口 (400|422)/.test(detail)) throw e;
        raw = "";
        toolNotes.length = 0;
        onError(
          "这个模型不收图（" + settings.model + "），这一轮只发了文字。设置里把模型换成 deepseek-flash 才能让她看见。"
        );
        messages = [systemMessage, { role: "user", content: transcript }];
        loop = await startLoop(messages);
      }
      raw = loop.text;
      spent = addUsage(spent, loop.usage);

      const parsed = parseNarrative(raw);
      let thought = parsed.thought;
      let speech = parsed.speech;

      const code = budget.review ? await loadPromptCode() : null;
      const hints = vetoHints(promptAssets.hints, null);
      let withRedos = history;

      for (let attempt = 0; code && attempt < REVIEW_POLICY.maxRetries; attempt += 1) {
        const verdictSeen = await collectDetailed(
          transport.stream({
            ...base,
            messages: buildReviewMessages(
              {
                feianFewShots: [],
                lang: "zh",
                currentState: thisMood,
                recentRecord: trimForContext(history.blocks, 12),
                currentTurnThought: thought,
                candidateSpeech: speech,
              },
              code
            ),
            maxTokens: 400,
          })
        );
        spent = addUsage(spent, verdictSeen.usage);
        const verdict = parseSupervisorVerdict(verdictSeen.text);
        if (decideReview(verdict, attempt, speech) === "pass") break;

        withRedos = appendBlocks(withRedos, [
          {
            kind: "system",
            label: "系统",
            body: "她打回了上一句：" + (verdict.reason ?? ""),
            at: new Date().toISOString(),
          },
        ]);

        const redoSeen = await collectDetailed(
          transport.stream({
            ...base,
            messages: [...messages, { role: "user", content: hints.respeak || hints.veto }],
            maxTokens: 2048,
          })
        );
        spent = addUsage(spent, redoSeen.usage);
        const again = parseNarrative(redoSeen.text);
        thought = again.thought || thought;
        // 重说没给出完整的「说」就别拿旧的顶上去——那正是被打回的那句。
        speech = again.speech || speech;
      }

      const tail: Block[] = [
        // 先把这一轮她用过的工具记下来：她"查过什么"本身也是上下文
        ...toolNotes,
      ];
      if (thought) tail.push({ kind: "herta", surface: "thought", text: thought, at: new Date().toISOString() });
      if (speech) {
        tail.push({
          kind: "herta",
          surface: "speech",
          text: speech,
          at: new Date().toISOString(),
          // 一次都没接到回执（别家接口不给 usage）就别挂一枚写着 0 的徽章
          ...(spent.calls ? { usage: spent } : {}),
        });
      }
      // 她挑中那张表情：单起一块，不贴在某句话上（表情没有台词，挂在话里会留个空段落）。
      // 块里只留引用，图仍在库里——删了库，历史还在，只是那张显示成「已删」。
      const herPick = pickedSticker as StickerRecord | null;
      if (herPick) {
        tail.push({
          kind: "sticker",
          from: "herta",
          stickerId: herPick.id,
          name: herPick.name,
          at: new Date().toISOString(),
        });
      }

      const final = appendBlocks(withRedos, tail);
      setSession(final);
      await persist(final);

      // 注意：这里**不**做梦。做梦要等她闲下来（见 App 里的空闲调度）——
      // 刚说完话就去做梦，等于你还没走她就当着你的面发呆。
    } catch (e) {
      if (ctl.signal.aborted) {
        // 打断不是错误：留下已经说出口的半句，别把红字糊她脸上。
        const partial = parseNarrative(raw).speech;
        const kept = partial ? appendBlocks(history, [{ kind: "herta", surface: "speech", text: partial, at: new Date().toISOString() }]) : history;
        setSession(kept);
        await persist(kept);
      } else {
        onError(e instanceof Error ? e.message : String(e));
        setSession(history);
        await persist(history);
      }
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }, [busy, files, memories, onError, onKeepSticker, onNeedKey, persist, session, settings, stickers]);

  const stop = useCallback(() => abort.current?.abort(), []);

  return { send, stop, busy, mood };
}
