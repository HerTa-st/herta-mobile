import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
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
  bondLevel,
  daysSince,
  decideReply,
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
import { recallNmsPromptSeeds } from "../nms/controller.ts";
import { captionImage } from "../vision.ts";
import { buildTools } from "../devtools.ts";
import { appendToolLog, loadMoodState, saveMoodState, type StickerRecord } from "../storage.ts";
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
  notifications: "看了通知栏",
  now_playing: "看了在放什么",
  media_control: "动了播放",
  read_screen: "看了屏幕",
  tap: "点了一下",
};

type TurnAttachment = { mediaType: string; data: string; name?: string };

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
  /** 回合结束（最终/拒答/打断/异常）时通知外层写 NMS pending_turns。 */
  onTurnEnd?(payload: { sessionId: string; turn: number; userText: string; assistantText: string; reason: "final" | "refused" | "aborted" | "error" }): void;
  /** 本轮 NMS 召回命中的节点，给网络视图点亮。 */
  onNmsRecall?(events: Array<{ id: number; activation: number }>): void;
  /** 自动语气（NMS）；没有就回落冻结的旧语气。 */
  nmsVoice?: { profile: string; paramsLine: string } | null;
}) {
  const { settings, session, setSession, persist, memories, dreamState, files, stickers, onKeepSticker, onError, onNeedKey, onTurnEnd, onNmsRecall, nmsVoice } = opts;
  const [busy, setBusy] = useState(false);
  /** 她在"想一下"的那几秒（或者说，在装作想一下）。 */
  const [typing, setTyping] = useState(false);
  const [mood, setMood] = useState<string>(DEFAULT_MOOD);
  /** 这次心情是几点定的（ms）。顶栏胶囊点开时只显示这个，不额外调模型。 */
  const [moodAt, setMoodAt] = useState<number | null>(null);
  // 打开 App 时把上次的心情接上；超过三小时 loadMoodState 会返回 null，就当没有
  useEffect(() => {
    let alive = true;
    void loadMoodState()
      .then((s) => {
        if (alive && s) {
          setMood(s.mood);
          setMoodAt(s.at);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const abort = useRef<AbortController | null>(null);
  /** 失败的那一轮：点「重发」按原样再来一次，不再追加用户块（否则会重复你的话）。 */
  const [failed, setFailed] = useState<{
    sessionId: string;
    history: Session;
    text: string;
    attachments?: TurnAttachment[];
    sticker?: StickerRecord;
  } | null>(null);

  /**
   * 从一段已有历史往下生成一轮。
   *
   * 正常发送、重发、单独重生成走的是同一段：区别只在于传进来的 history
   * 停在哪一块。用户块由调用方负责先落进 history，这里只负责生成。
   */
  const runTurn = useCallback(async (
    history: Session,
    text: string,
    attachments?: TurnAttachment[],
    sticker?: StickerRecord
  ) => {
    onError(null);
    setFailed(null);
    setBusy(true);

    // pending_turns 的写入点：正常、拒答、打断、异常都要覆盖；同一轮只发一次。
    let turnEndSent = false;
    const emitTurnEnd = (blocks: readonly Block[], reason: "final" | "refused" | "aborted" | "error") => {
      if (turnEndSent || onTurnEnd === undefined) return;
      turnEndSent = true;
      let turn = 0;
      for (const block of blocks) if (block.kind === "user" || block.kind === "sticker") turn += 1;
      const fresh = blocks.slice(history.blocks.length);
      const assistantText = fresh
        .filter((block): block is Extract<Block, { kind: "herta" }> => block.kind === "herta" && block.surface === "speech")
        .map((block) => block.text)
        .join("\n");
      onTurnEnd({
        sessionId: history.id,
        turn,
        userText: text.trim().length > 0 ? text : sticker?.name ?? "",
        assistantText,
        reason,
      });
    };

    /**
     * 接不接、多久接。
     *
     * 这段在请求之前——不接的时候连模型都不叫，那才是真的"没回"，
     * 而不是"回了又被藏起来"。关系从会话长度、记忆篇数、认识天数里算。
     */
    if (settings.replyPacing !== false) {
      const bond = bondLevel({
        blocks: history.blocks.length,
        memories: memories.length,
        days: daysSince(history.createdAt),
      });
      const decision = decideReply({ text, bond });
      if (!decision.reply) {
        const note: Block = {
          kind: "system",
          label: "系统",
          body: "（她看到了，没接话）",
          at: new Date().toISOString(),
        };
        const kept = appendBlocks(history, [note]);
        setSession(kept);
        await persist(kept);
        emitTurnEnd(kept.blocks, "refused");
        setBusy(false);
        return;
      }
      if (decision.delayMs > 0) {
        setTyping(true);
        await new Promise((r) => setTimeout(r, decision.delayMs));
        setTyping(false);
      }
    }

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
      // 原生 NMS：按本轮文本走联想召回（会写回 recall/reinforce）；Web/失败回退旧 pickSeeds。
      let seeds: string[] = [];
      if (Capacitor.isNativePlatform()) {
        try {
          const recalled = await recallNmsPromptSeeds(text, budget.memorySeeds);
          seeds = recalled.seeds;
          if (recalled.events.length > 0) onNmsRecall?.(recalled.events);
        } catch {
          seeds = [];
        }
      }
      if (seeds.length === 0) {
        const pool = memories.map((m) => ({ file: m.name, body: m.body }));
        seeds = pickSeeds(pool, text, budget.memorySeeds);
      }
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
            setMoodAt(decision.state.at);
          }
        } catch {
          /* 判不出来就保持上一轮 */
        }
        setMood(thisMood);
      }

      const styleNote = budget.mood ? moodStyleNote(promptAssets, thisMood) : null;
      // 引导页里填的名字：有自动语气时只报事实（称呼方式按她自己的性子），
      // 没有自动语气就明确让她用这个名字叫。
      const userName = settings.userName.trim();
      const nameNote = userName
        ? nmsVoice
          ? "〔旁注：他叫「" + userName + "」。这是他的名字；怎么称呼他，按你现在的性子来。〕"
          : "〔旁注：他叫「" + userName + "」。称呼他的时候用这个名字。〕"
        : null;
      // 她此刻在哪：按钟点算，同一天同一时段固定，隔天才换。
      const presenceNote = buildPresenceNote(presenceAt(), timePhrase());
      const prefix = buildStaticPrefix({
        assets: promptAssets,
        seeds,
        // 有自动语气就用它；还没生成过才回落冻结的旧语气。
        voiceText: nmsVoice?.profile || voiceTextOf(dreamState),
        voiceParams: nmsVoice?.paramsLine ?? null,
        presence: presenceNote,
        extraNotes: [styleNote ? "〔旁注：" + styleNote + "〕" : null, nameNote].filter(
          (note): note is string => Boolean(note)
        ),
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
          notify: settings.notifyEnabled,
          media: settings.mediaEnabled,
          a11y: settings.a11yEnabled,
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
                // 聊天流里不显示（设计文档 §5 根⑤）；转录序列化不过滤，工具记录页另有全量审计。
                hidden: true,
              };
              toolNotes.push(note);
              setSession({ ...history, blocks: [...history.blocks, ...toolNotes] });
              // 单独的审计记录：她从哪一句话里调了什么、带什么参数、成没成
              void appendToolLog({
                at: note.at,
                sessionId: history.id,
                name: result.name,
                label: TOOL_LABEL[result.name] ?? result.name,
                ok: result.ok,
                args: JSON.stringify(result.args ?? {}),
                content: String(result.content).replace(/\s+/g, " ").slice(0, 400),
              }).catch(() => undefined);
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
      setFailed(null);
      setSession(final);
      await persist(final);
      emitTurnEnd(final.blocks, "final");

      // 注意：这里**不**做梦。做梦要等她闲下来（见 App 里的空闲调度）——
      // 刚说完话就去做梦，等于你还没走她就当着你的面发呆。
    } catch (e) {
      if (ctl.signal.aborted) {
        // 打断不是错误：留下已经说出口的半句，别把红字糊她脸上。
        const partial = parseNarrative(raw).speech;
        const kept = partial ? appendBlocks(history, [{ kind: "herta", surface: "speech", text: partial, at: new Date().toISOString() }]) : history;
        setFailed(null);
        setSession(kept);
        await persist(kept);
        emitTurnEnd(kept.blocks, "aborted");
      } else {
        const detail = e instanceof Error ? e.message : String(e);
        // 你的话留在会话里，不因为网断了就被吞掉；「重发」从这一段历史接着生成。
        setFailed({ sessionId: history.id, history, text, attachments, sticker });
        onError("没发出去：" + detail);
        setSession(history);
        await persist(history);
        emitTurnEnd(history.blocks, "error");
      }
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }, [dreamState, files, memories, nmsVoice, onError, onKeepSticker, onNmsRecall, onTurnEnd, persist, setSession, settings, stickers]);

  /** 正常发一条：先把用户的块落进会话，再从那里往下生成。 */
  const send = useCallback(
    async (text: string, attachments?: TurnAttachment[], sticker?: StickerRecord) => {
      if ((!text.trim() && !attachments?.length && !sticker) || busy || !session) return;
      if (!settings.apiKey) {
        // 未接通不是错误（设计文档 §4.1）：只把她领到设置去填，界面上不弹红字。
        onNeedKey();
        return;
      }
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
      setFailed(null);
      const history = appendBlocks(session, [opening]);
      setSession(history);
      void persist(history);
      await runTurn(history, text, attachments, sticker);
    },
    [busy, onNeedKey, persist, runTurn, session, setSession, settings.apiKey]
  );

  /**
   * 重新生成：把会话截到 startIndex，再从这里往下说。
   *
   * startIndex 之前的最后一块用户/表情是这个回合的起点——不新增用户块，
   * 否则长按重生成一次就多一句"你"。
   */
  const regenerate = useCallback(
    async (startIndex: number) => {
      if (busy || !session) return;
      if (!settings.apiKey) {
        onNeedKey();
        return;
      }
      const base = session.blocks.slice(0, Math.max(0, startIndex));
      let last: Block | null = null;
      for (let i = base.length - 1; i >= 0; i -= 1) {
        const block = base[i];
        if (block.kind === "user" || (block.kind === "sticker" && block.from === "user")) {
          last = block;
          break;
        }
      }
      if (!last) return;
      // 表情库删了就重说不了——先查再截，别把后面的对话白丢。
      const stickerRecord =
        last.kind === "sticker" ? stickers.find((s) => s.id === last.stickerId) ?? null : null;
      if (last.kind === "sticker" && !stickerRecord) return;
      setFailed(null);
      const truncated: Session = { ...session, blocks: base, updatedAt: new Date().toISOString() };
      setSession(truncated);
      await persist(truncated);
      if (last.kind === "user") {
        await runTurn(truncated, last.text, last.attachments);
      } else if (stickerRecord) {
        await runTurn(truncated, "", undefined, stickerRecord);
      }
    },
    [busy, onNeedKey, persist, runTurn, session, setSession, settings.apiKey, stickers]
  );

  /** 重发失败的那一轮：历史原样，只重跑生成。 */
  const retry = useCallback(async () => {
    if (!failed || busy || !session || failed.sessionId !== session.id) return;
    await runTurn(failed.history, failed.text, failed.attachments, failed.sticker);
  }, [busy, failed, runTurn, session]);

  // 换了会话就把「重发」收掉：那条失败属于另一条会话。
  useEffect(() => {
    setFailed((current) => (current && current.sessionId !== session?.id ? null : current));
  }, [session?.id]);

  // 中途被打断（打断/切会话）别把"正在输入"留在界面上
  useEffect(() => () => setTyping(false), []);

  const stop = useCallback(() => abort.current?.abort(), []);

  return { send, stop, busy, mood, moodAt, typing, regenerate, retry, failed };
}
