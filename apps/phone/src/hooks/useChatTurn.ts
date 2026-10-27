import { useCallback, useRef, useState } from "react";
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
  moodStyleNote,
  parseMood,
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
} from "@herta/core";
import { BrowserAssetSource } from "../assets-browser.ts";
import { buildTools } from "../devtools.ts";
import type { StickerRecord } from "../storage.ts";
import { loadPromptCode } from "../prompts.ts";
import type { Settings } from "../settings.ts";
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
  onError(message: string | null): void;
  onNeedKey(): void;
}) {
  const { settings, session, setSession, persist, memories, dreamState, files, stickers, onError, onNeedKey } = opts;
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState<string>(DEFAULT_MOOD);
  const abort = useRef<AbortController | null>(null);
  const send = useCallback(async (text: string, attachments?: { mediaType: string; data: string; name?: string }[]) => {
    if ((!text.trim() && !attachments?.length) || busy || !session) return;
    if (!settings.apiKey) {
      onError("先填 API Key。她不会替你保管，只存在这台手机上。");
      onNeedKey();
      return;
    }
    onError(null);
    setBusy(true);
    

    const userBlock: Block = {
      kind: "user",
      text,
      at: new Date().toISOString(),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    const history = appendBlocks(session, [userBlock]);
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

    let raw = "";
    /** 这一轮花掉的 token：判心情、主对话（含工具轮）、复核、重说，全加进来。 */
    let spent = emptyUsage();
    try {
      const promptAssets = await assets.promptAssets();
      // 这一轮用哪几篇记忆：开局定死，想 / 说 / 复核共用同一批（否则三趟看到的她不一样）。
      const pool = memories.map((m) => ({ file: m.name, body: m.body }));
      const seeds = pickSeeds(pool, text, settings.memorySeeds);
      const context = trimForContext(history.blocks, settings.contextBlocks);

      // 先判心情：一次十几个 token 的调用，换来她这一轮的语气基线不一样。
      // 判定失败就按默认走——心情不该成为整轮对话的单点故障。
      let thisMood = DEFAULT_MOOD;
      if (settings.moodEnabled) {
        try {
          const pack = await assets.mood();
          if (pack) {
            const p = buildMoodPrompt(pack, serializeRecord(trimForContext(history.blocks, 12), { maxBlocks: 0 }));
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
            thisMood = parseMood(seen.text, pack.moods);
          }
        } catch {
          thisMood = DEFAULT_MOOD;
        }
        setMood(thisMood);
      }

      const styleNote = settings.moodEnabled ? moodStyleNote(promptAssets, thisMood) : null;
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
      const pictures: ChatPart[] = (userBlock.attachments ?? []).map((a) => ({
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
        stickers,
        visionModel: settings.visionModel,
        albumEnabled: settings.albumEnabled,
        onSticker: (record) => {
          pickedSticker = record;
        },
      });
      const toolNotes: Block[] = [];

      const startLoop = (seed: readonly ChatMessage[]) =>
        runToolLoop(
          {
            tools,
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

      const code = settings.reviewEnabled ? await loadPromptCode() : null;
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
          ...(pickedSticker
            ? {
                attachments: [
                  { mediaType: (pickedSticker as StickerRecord).mediaType, data: (pickedSticker as StickerRecord).data, name: (pickedSticker as StickerRecord).name },
                ],
              }
            : {}),
          // 一次都没接到回执（别家接口不给 usage）就别挂一枚写着 0 的徽章
          ...(spent.calls ? { usage: spent } : {}),
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
  }, [busy, files, memories, onError, onNeedKey, persist, session, settings]);

  const stop = useCallback(() => abort.current?.abort(), []);

  return { send, stop, busy, mood };
}
