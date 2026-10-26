/**
 * 三端（手机 / PC 网关 / 油猴脚本）共用的类型与消息。
 * 一条纪律：**协议只在这一处定义**。任何一端想加字段，先改这里再看别处能不能编译。
 */

export type Lang = "zh" | "en";

/* ---------------------------------------------------------------- 会话模型 */

export type BlockKind = "user" | "herta" | "system";

/** 桌面版只认这两个标签；导入时工具调用必须降采样成 system 块，不能自造标签。 */
export type SystemLabel = "系统" | "差分协处理器";

export interface UserBlock {
  kind: "user";
  text: string;
  at: string;
  /** 手机本地存的附件（base64 或 objectURL 引用）；导入时一律丢弃。 */
  attachments?: { mediaType: string; data: string; name?: string }[];
}

export interface HertaBlock {
  kind: "herta";
  /** thought 走"想"轨，speech 走"说"轨——这是她的人格语法，不许合并。 */
  surface: "speech" | "thought";
  text: string;
  at: string;
  /** 她随话发出去的表情（一张图）。 */
  attachments?: { mediaType: string; data: string; name?: string }[];
}

export interface SystemBlock {
  kind: "system";
  label: SystemLabel;
  body: string;
  digest?: string;
  at: string;
}

export type Block = UserBlock | HertaBlock | SystemBlock;

export type SessionOrigin = "phone" | "import" | "pc";

export interface Session {
  id: string;
  title: string;
  origin: SessionOrigin;
  createdAt: string;
  updatedAt: string;
  blocks: Block[];
}

/* -------------------------------------------------------------- 导入模型 */

/** 油猴脚本产出的中间格式。手机与网关都只认这一个形状。 */
export interface ImportBundle {
  format: "herta-import";
  version: 1;
  source: "deepseek-web";
  exportedAt: string;
  /** 采集端版本，用于脚本失效时区分"没数据"与"数据格式变了"。 */
  collector: { name: string; version: string };
  sessions: ImportedSession[];
}

export interface ImportedSession {
  /** 站点侧的会话 id；去重与增量都要靠它。 */
  id: string;
  title: string;
  startedAt: string;
  messages: ImportedMessage[];
}

export interface ImportedMessage {
  role: "user" | "assistant";
  text: string;
  /** 站点侧不一定给时间；没有就留空，别拿导出时间冒充。 */
  at?: string;
}

/* ------------------------------------------------------------- 模型调用 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 模型发起的工具调用（OpenAI 函数调用格式，arguments 是 JSON 字符串）。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 一条消息里的一段内容。现在只用到文字与图片两种。 */
export type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: MessageRole;
  /** 纯文字时是字符串；带图时是片段数组。 */
  content: string | ChatPart[];
  /** assistant 消息里挂着的工具调用。 */
  tool_calls?: ToolCall[];
  /** role=tool 时，对应哪一次调用。 */
  tool_call_id?: string;
  /** 工具名，给 UI 显示用（协议里不要求，模型也不看）。 */
  name?: string;
}

/** 工具声明。 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema。 */
  parameters: Record<string, unknown>;
}

/** 流里吐出来的东西：文字、工具调用增量、结束标记。 */
export type ChatDelta =
  | { type: "text"; text: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "done"; finishReason: string | null };

/* ------------------------------------------------------------ 网关协议 v2 */

/** 手机 → PC。 */
export type GatewayRequest =
  | { type: "hello"; token: string; client: { name: string; version: string } }
  | { type: "call"; id: string; method: string; args: unknown[] }
  | { type: "ping" };

/** PC → 手机。事件走 `event`，方法返回值走 `result`。 */
export type GatewayMessage =
  | { type: "ready"; protocol: 2; pc: { name: string; version: string }; session: Session | null }
  | { type: "result"; id: string; ok: true; value: unknown }
  | { type: "result"; id: string; ok: false; error: string }
  | { type: "event"; name: string; payload: unknown };

/** 网关方法白名单。**加方法要先改这里**——手机端不该能调用列表之外的东西。 */
export const GATEWAY_METHODS = [
  "session.list",
  "session.open",
  "session.create",
  "turn.submit",
  "turn.interrupt",
  "turn.retract",
  "approval.resolve",
  "voice.speak",
] as const;

export type GatewayMethod = (typeof GATEWAY_METHODS)[number];
