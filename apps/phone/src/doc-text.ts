/**
 * 从 PDF / Word / Excel / PPT 里抽纯文字。
 *
 * 手机上没有 Python，也没有 LibreOffice，所以把解析库塞进包里：
 * - PDF：pdfjs-dist（官方 PDF.js 的 npm 包，只抽文字层，不渲染）。中文 PDF 的
 *   CID 字体要靠 Adobe CMaps，运行时从 /pdfjs/cmaps/ 取（构建前由
 *   tools/copy-pdfjs-cmaps.mjs 拷进 publicDir）。
 * - docx / pptx / xlsx：本质是 zip + xml，用 fflate 解压后交给 core 里的纯函数抽文字。
 * - 老版 .doc / .xls / .ppt 是二进制复合文档，不支持（会明确说读不了，不硬读成乱码）。
 *
 * 抽出的是纯文字，版式会丢——read_file 要的是内容，不是排版。
 */
import { DOC_FILE_EXTENSIONS, DOC_FILE_MAX_BYTES, docxXmlToText, pptxXmlToText, xlsxXmlToText } from "@herta/core";
import { unzipSync } from "fflate";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

export type DocumentFormat = "pdf" | "docx" | "pptx" | "xlsx";

/** 抽文字最多读这么多页：一部 800 页的 PDF 全抽一遍会让手机卡住，而且 read_file 也只看前 8000 字。 */
const PDF_PAGE_LIMIT = 100;

/**
 * 认格式：先扩展名（安卓上最可靠），再拿 MIME 兜底——分享进来的 PDF 有时没有扩展名。
 */
export function documentFormatOf(name: string, type = ""): DocumentFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if ((DOC_FILE_EXTENSIONS as readonly string[]).includes(ext)) return ext as DocumentFormat;
  const mime = String(type).toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("wordprocessingml")) return "docx";
  if (mime.includes("spreadsheetml")) return "xlsx";
  if (mime.includes("presentationml")) return "pptx";
  return null;
}

/** PDF 的 worker 只在第一次用时创建；创建后复用，别每份 PDF 起一个。 */
let pdfWorker: Worker | null = null;
function ensurePdfWorker(): void {
  if (pdfWorker) return;
  pdfWorker = new PdfWorker();
  GlobalWorkerOptions.workerPort = pdfWorker;
}

/** worker 崩了 / OOM 后端口是死的：清掉，下一份 PDF 重建，别让这个会话从此读不了 PDF。 */
function resetPdfWorker(): void {
  try {
    pdfWorker?.terminate();
  } catch {
    /* 已经死了就算了 */
  }
  pdfWorker = null;
  GlobalWorkerOptions.workerPort = null;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
  return Math.round(n / 1024) + "KB";
}

async function extractPdfText(file: File): Promise<string> {
  ensurePdfWorker();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await getDocument({
    data,
    // 中文 PDF 的 CID 字体要 CMaps；不打包这个，抽出来不是乱码就是空
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  }).promise;
  try {
    const total = doc.numPages;
    const pages = Math.min(total, PDF_PAGE_LIMIT);
    const out: string[] = [];
    for (let i = 1; i <= pages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      const trimmed = text.trim();
      if (trimmed) out.push(trimmed);
      page.cleanup();
    }
    if (total > pages) out.push("（这个 PDF 有 " + total + " 页，只抽了前 " + pages + " 页）");
    return out.join("\n\n");
  } catch (err) {
    // 抽到一半失败（worker 崩/OOM）：先把死掉的 worker 清掉
    resetPdfWorker();
    throw err;
  } finally {
    await doc.destroy();
  }
}

/** 解压后最多读这么多字节：20MB 的 zip 解出 500MB 的 XML 会把 WebView 内存打爆。 */
const UNZIP_MAX_BYTES = 32 * 1024 * 1024;

const SLIDE_XML = /^ppt\/slides\/slide\d+\.xml$/;
const SHEET_XML = /^xl\/worksheets\/sheet\d+\.xml$/;

/**
 * 只解出我们真正要的条目（正文 / 幻灯片 / 工作表 + 共享字符串），
 * 图片、主题、样式一律跳过——解它们纯属浪费内存。再兜一道解压总量上限。
 */
async function unzipOoxml(
  file: File,
  keep: readonly ((path: string) => boolean)[]
): Promise<Record<string, Uint8Array>> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let total = 0;
  try {
    return unzipSync(bytes, {
      filter: (entry) => {
        if (!keep.some((rule) => rule(entry.name))) return false;
        total += entry.originalSize;
        if (total > UNZIP_MAX_BYTES) throw new Error("这个文件解压后太大了（超过 32MB）。");
        return true;
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/太大/.test(message)) throw err;
    throw new Error("这个文件解不开（可能不是真正的 " + file.name.split(".").pop()?.toUpperCase() + "，或者坏了）。");
  }
}

function zipText(zip: Record<string, Uint8Array>, path: string): string {
  const bytes = zip[path];
  return bytes ? new TextDecoder("utf-8").decode(bytes) : "";
}

function numbered(zip: Record<string, Uint8Array>, pattern: RegExp): string[] {
  return Object.keys(zip)
    .filter((path) => pattern.test(path))
    .sort((a, b) => {
      const na = Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0);
      const nb = Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);
      return na - nb;
    });
}

export interface ExtractedDocument {
  format: DocumentFormat;
  text: string;
}

/**
 * 抽文档文字。失败时抛一句能念给人听的中文（她看不到控制台）。
 *
 * 扫描件 PDF 会返回空串——没有文字层谁也抽不出来，调用方负责提示"转成图片看"。
 */
export async function extractDocumentText(file: File): Promise<ExtractedDocument> {
  const format = documentFormatOf(file.name, file.type);
  if (!format) throw new Error("这不是支持抽文字的文档格式。");
  if (file.size > DOC_FILE_MAX_BYTES) {
    throw new Error("这个文件有 " + formatBytes(file.size) + "，太大了——文档上限是 20MB。");
  }
  if (format === "pdf") {
    try {
      return { format, text: await extractPdfText(file) };
    } catch (err) {
      // pdf.js 对"加密/损坏"有专门的异常类型，但对外只要一句人话
      const message = err instanceof Error ? err.message : String(err);
      if (/password/i.test(message)) throw new Error("这个 PDF 有密码，解不开——先去掉密码再选。");
      // pdf.js v4 用了 Promise.withResolvers 之类的新 API：老 WebView 会抛「不是函数」，别报成文件坏了
      if (/withresolvers|is not a function|not a function/i.test(message)) {
        throw new Error("这台手机的 WebView 太旧，读不了 PDF——更新一下 Android System WebView，或者把 PDF 转成图片/文本再发。");
      }
      if (/worker|fake worker|cannot load script/i.test(message)) {
        throw new Error("PDF 的解析进程没起来——重开一下 App 再试，还不行就更新 WebView。");
      }
      throw new Error("这个 PDF 打不开（可能坏了）：" + message);
    }
  }

  if (format === "docx") {
    const zip = await unzipOoxml(file, [(path) => path === "word/document.xml"]);
    const xml = zipText(zip, "word/document.xml");
    if (!xml) throw new Error("这个 docx 里没找到正文。");
    return { format, text: docxXmlToText(xml) };
  }
  if (format === "pptx") {
    const zip = await unzipOoxml(file, [(path) => SLIDE_XML.test(path)]);
    const slides = numbered(zip, SLIDE_XML);
    if (slides.length === 0) throw new Error("这个 pptx 里没找到幻灯片。");
    return { format, text: pptxXmlToText(slides.map((path) => zipText(zip, path))) };
  }
  const zip = await unzipOoxml(file, [(path) => SHEET_XML.test(path) || path === "xl/sharedStrings.xml"]);
  const sheets = numbered(zip, SHEET_XML);
  if (sheets.length === 0) throw new Error("这个 xlsx 里没找到工作表。");
  return {
    format,
    text: xlsxXmlToText(
      sheets.map((path) => zipText(zip, path)),
      zipText(zip, "xl/sharedStrings.xml")
    ),
  };
}
