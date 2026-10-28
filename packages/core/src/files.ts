/**
 * 「选文件」挑回来的东西分几类。
 *
 * 手机上的文件管理器给回的 MIME 不完全可靠：有时是空串，有时一律 octet-stream，
 * Excel 导出的中文 CSV 还会被标成 application/vnd.ms-excel。所以扩展名是第二道判据，
 * 而且文档 MIME 与文本扩展名打架时以扩展名兜底。这里只按名字与 MIME 判，不读内容——
 * 为了猜类型先 IO 一遍大文件不划算，而分类错误（把 PDF 当文本读成乱码）比不读更糟。
 *
 * 分类决定后面走哪条路：
 * - image：进看图管线（和相机同一条）
 * - text：解成字符串，放进她能读的文件（read_file 工具）
 * - doc：PDF / DOCX / PPTX / XLSX——先抽文字，再走 text 同一条落库路径
 * - other：二进制 / 暂时读不了的格式，明确拒绝，不硬读成乱码
 */
export type PickedFileKind = "image" | "text" | "doc" | "other";

export interface PickedFileInfo {
  name: string;
  /** File.type；文件管理器不给时是空串。 */
  type?: string;
}

/** 图片扩展名。HEIC/HEIF 故意不算：WebView 基本解不了，单独给一句人话。 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|jfif|svg|avif)$/i;

/**
 * 能当文本读的扩展名。宁多勿少：多列一个不会出错，漏一个用户就得改文件格式。
 * 导出是为了设置页的 <input accept> 与这里共用一份清单，别两处各维护一行。
 */
export const TEXT_FILE_EXTENSIONS: readonly string[] = [
  "txt", "text", "md", "markdown", "mdx", "json", "jsonl", "ndjson", "jsonc", "json5", "geojson", "ipynb",
  "csv", "tsv", "log", "ini", "conf", "cfg", "yaml", "yml", "xml", "html", "htm", "css", "scss", "less",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte",
  "py", "pyi", "java", "kt", "kts", "gradle", "groovy", "c", "h", "cc", "cpp", "hpp", "cs",
  "go", "rs", "rb", "php", "swift", "lua", "pl", "r", "dart", "scala", "clj", "ex", "exs",
  "erl", "hs", "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1",
  "sql", "toml", "env", "properties", "srt", "vtt", "ass", "tex", "bib",
  "patch", "diff", "lock", "gitignore", "dockerignore", "npmignore", "editorconfig",
  "local", "development", "production", "test",
];

/** 没有扩展名也一眼是文本的常见文件（Dockerfile / Dockerfile.dev / Makefile 这类）。 */
const PLAIN_TEXT_NAME =
  /^(dockerfile|makefile|jenkinsfile|procfile|gemfile|rakefile|vagrantfile|brewfile|justfile)(\.[a-z0-9._-]+)?$/i;

const TEXT_EXT = new RegExp("\\.(" + TEXT_FILE_EXTENSIONS.join("|") + ")$", "i");

/** 文本文件读进内存的上限。read_file 只回 8000 字，再大也是浪费内存。 */
export const TEXT_FILE_MAX_BYTES = 512 * 1024;

/** 能抽文字出来的文档格式（新版 Office 是 zip+xml；老版 .doc/.xls/.ppt 是二进制，不支持）。 */
export const DOC_FILE_EXTENSIONS: readonly string[] = ["pdf", "docx", "pptx", "xlsx"];

const DOC_EXT = new RegExp("\\.(" + DOC_FILE_EXTENSIONS.join("|") + ")$", "i");

/** 源文件（PDF/Office）大小上限：手机上解大 PDF 会卡，先兜一道。 */
export const DOC_FILE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 文件库事件的 system 旁白（「已放进她能读的文件里」/「已从她能读的文件里移出」）。
 * v0.28.10 起这类块的 hidden=true，聊天流不显示、只进「工具调用记录」；
 * 这里再按正文认一遍，是为了兼容升级前写下的老块与老备份。
 */
export const READABLE_FILE_EVENT_NOTE = /已放进她能读的文件里|已从她能读的文件里移出/;

/** OOXML / PDF 的 MIME：pdf、vnd.openxmlformats-officedocument.* */
const DOC_MIME = /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml|spreadsheetml|presentationml)\.)/;

/**
 * 这个挑选回来的文件该走哪条路。
 *
 * 顺序有讲究：
 * 1. MIME 里的 image / text 最可信（HEIC 除外）；
 * 2. 音视频与文档/压缩包先判成 other，别让扩展名把 MPEG-TS 的 .ts 捞成 TypeScript；
 *    但文档 MIME 与文本扩展名冲突时以扩展名为准（Excel 的 CSV）；
 * 3. 剩下的才看扩展名。
 */
export function classifyPickedFile(file: PickedFileInfo): PickedFileKind {
  const mime = String(file.type ?? "").toLowerCase();
  const name = String(file.name ?? "");
  // HEIC/HEIF 是图片，但 WebView 解不了；归 other，让 pickFile 给专门的一句话。
  // 用前缀：相册导出可能给 image/heic-sequence 这类带后缀的 MIME
  if (mime.startsWith("image/heic") || mime.startsWith("image/heif")) return "other";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/json" || mime.endsWith("+json")) return "text";
  if (mime === "application/xml" || mime.endsWith("+xml")) return "text";
  // PDF / 新版 Office：能抽出文字，走 doc 那条（先抽再落库）
  if (DOC_MIME.test(mime)) return "doc";
  // .ts 双义：Android 的 MimeTypeMap 把 .ts 映射成 video/mp2t，真正的 TypeScript 源码会被误拒。
  // 视频很少用 .ts 传，而且 512KB 上限 + 文本解码校验会把视频挡掉，所以按源码处理。
  if (mime === "video/mp2t" && /\.ts$/i.test(name)) return "text";
  if (/^(video|audio|font)\//.test(mime)) return "other";
  if (
    /^application\/(pdf|zip|gzip|x-7z-compressed|x-rar-compressed|vnd\.rar|msword|vnd\.openxmlformats-officedocument|vnd\.ms-excel|vnd\.ms-powerpoint)/.test(
      mime
    )
  ) {
    // Excel 导出的 CSV 常被标成 vnd.ms-excel；扩展名是文本就别拒
    if (TEXT_EXT.test(name)) return "text";
    // .xlsx/.docx 被塞进 zip/office 的 MIME 时靠扩展名兜住
    if (DOC_EXT.test(name)) return "doc";
    return "other";
  }
  if (IMAGE_EXT.test(name)) return "image";
  if (DOC_EXT.test(name)) return "doc";
  if (TEXT_EXT.test(name)) return "text";
  if (PLAIN_TEXT_NAME.test(name)) return "text";
  return "other";
}

export interface DecodedText {
  text: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "gbk";
}

/**
 * 把文件字节解成文本。
 *
 * 手机上的 txt / csv 不一定是 UTF-8：Excel 导出的中文 CSV 常见 GBK，老记事本是 UTF-16。
 * 直接按 UTF-8 解不会抛错，只会静默出一堆 U+FFFD——她读到的就是垃圾，还会照着垃圾回答。
 * 先看 BOM，再试严格 UTF-8，最后回退 GBK；都不行或者解出来不像文本就抛，让上层报清楚。
 */
export function decodeTextFile(bytes: Uint8Array): DecodedText {
  let decoded: DecodedText;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    decoded = { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    decoded = { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    decoded = { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  } else {
    try {
      decoded = { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
    } catch {
      // 不是合法 UTF-8：老中文文件大概率是 GBK
      try {
        decoded = { text: new TextDecoder("gbk").decode(bytes), encoding: "gbk" };
      } catch {
        throw new Error("这个文件的编码认不出来——另存成 UTF-8 再选一次。");
      }
    }
  }
  // 空文件 / 只有 BOM：收进去她只会读到一片空白，不如当场说清楚
  if (!decoded.text.trim()) throw new Error("这个文件是空的。");
  // 二进制（视频/压缩包）被当文本读时，通常带 NUL 或一堆替换字符；别让它静默进她的文件库
  if (decoded.text.includes("\u0000")) throw new Error("这不像是文本文件。");
  if (decoded.encoding === "gbk" && decoded.text.includes("\uFFFD")) {
    throw new Error("这个文件的编码认不出来——另存成 UTF-8 再选一次。");
  }
  return decoded;
}

/**
 * 文件名进对话 / system 块前的清洗。
 *
 * 文件名会被原样拼进〔系统〕旁白（read_file 的名单也是），带换行、控制字符或
 * 「」〔〕 的名字能伪造一行系统旁白——这是注入面。只留可读内容，最长 60 字。
 */
export function sanitizeFileName(name: string): string {
  const cleaned = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[「」〔〕]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "（未命名文件）").slice(0, 60);
}

/** 「她能读的文件」整库文本上限（字符数）。单文件 512KB，四份左右封顶。 */
export const READABLE_FILES_MAX_CHARS = 2 * 1024 * 1024;

export interface TextFileRecord {
  name: string;
  text: string;
}

/**
 * 超上限时从最早的那份开始丢（list 按加入时间从旧到新）。至少留一份，
 * 否则用户刚加的文件可能因为上限设置得比单文件还小而被立刻吞掉。
 */
export function trimTextFiles<T extends TextFileRecord>(list: readonly T[], maxChars = READABLE_FILES_MAX_CHARS): T[] {
  const kept = [...list];
  let total = kept.reduce((n, f) => n + f.text.length, 0);
  while (kept.length > 1 && total > maxChars) {
    const dropped = kept.shift() as T;
    total -= dropped.text.length;
  }
  return kept;
}

export interface MergedTextFiles<T extends TextFileRecord> {
  kept: T[];
  /** 这一次因为超上限被挤掉的名字（从旧到新）。 */
  dropped: string[];
}

/**
 * 把一份新文件并进列表：同名替换不算"丢"，超上限时被挤掉的名字要报给调用方。
 * 这是「她能读的文件」落盘的核心逻辑，放这里是为了能被 Node 测试（app 层没有测试基建）。
 */
export function mergeTextFile<T extends TextFileRecord>(
  list: readonly T[],
  record: T,
  maxChars = READABLE_FILES_MAX_CHARS
): MergedTextFiles<T> {
  const before = list.map((f) => f.name);
  const kept = trimTextFiles([...list.filter((f) => f.name !== record.name), record], maxChars);
  const keptNames = new Set(kept.map((f) => f.name));
  return { kept, dropped: before.filter((name) => name !== record.name && !keptNames.has(name)) };
}
