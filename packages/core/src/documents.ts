/**
 * 从 Office（docx / pptx / xlsx）的 XML 里抽纯文字。
 *
 * 这些是纯字符串处理，放在 core 才能用 Node 单测；解 zip 与读文件在 app 层
 * （app 没有测试基建）。只抽文字、不保版式——read_file 要的是内容；
 * 段落、表格行列、页序尽量留住，够她读懂就行。
 *
 * 注意：老版 .doc / .xls / .ppt 是二进制复合文档，这里不碰（也不该硬读成乱码）。
 */

/** XML 实体反解（含 &#13; / &#x0d; 这类数字实体）。看不出的一律原样留着。 */
export function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default:
        return whole;
    }
  });
}

/** 取一段 XML 里所有指定标签的文字（用于 Word 的 <w:t>、PPT 的 <a:t>）。 */
function tagTexts(xml: string, tag: string): string[] {
  const re = new RegExp("<(?:[^:>]+:)?" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[^:>]+:)?" + tag + ">", "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(decodeXmlEntities(m[1]));
  return out;
}

/**
 * Word 正文：word/document.xml → 纯文字。
 * 段落之间换行；<w:tab/> 转制表符、<w:br/>/<w:cr/> 转换行；空段落丢掉。
 */
export function docxXmlToText(xml: string): string {
  return xml
    .split(/<\/w:p>/)
    .map((para) => {
      // 先把独立标签变成一段"假文字"，这样它们会落在 <w:t> 之外也能被拼进去
      const prepared = para
        .replace(/<w:tab[^>]*\/>/g, "<w:t>\t</w:t>")
        .replace(/<w:(?:br|cr)[^>]*\/>/g, "<w:t>\n</w:t>");
      return tagTexts(prepared, "t").join("").replace(/[ \t]+$/gm, "").trim();
    })
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * PPT：按页给文字，页与页之间空一行。传进来的顺序就是页序。
 * 一段文字常被拆成好几个 run（改过字体/颜色就是一段一个 run），段内要拼回去，
 * 否则抽出来会一行一个词。按 </a:p> 拆段，段内 run 直接连接。
 */
export function pptxXmlToText(slides: readonly string[]): string {
  return slides
    .map((xml, index) => {
      const paragraphs = xml
        .split(/<\/a:p>/)
        .map((para) => tagTexts(para, "t").join("").trim())
        .filter(Boolean);
      const body = paragraphs.join("\n");
      return body ? "第 " + (index + 1) + " 页\n" + body : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Excel：sharedStrings 存文字、工作表 XML 存单元格。
 * 每行一行、单元格用制表符隔开；数字原样保留。几张表按传入顺序排。
 */
export function xlsxXmlToText(sheets: readonly string[], sharedStringsXml = ""): string {
  const shared = [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => tagTexts(m[1], "t").join(""));

  return sheets
    .map((xml, index) => {
      const rows = [...xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)]
        .map((row) => {
          // 自闭合的空单元格 <c r="B2"/> 也要算一格，否则后面的列会左移、整行对不上
          const cells = [...row[1].matchAll(/<c(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)];
          return cells
            .map((cell) => {
              const head = cell[0].slice(0, cell[0].indexOf(">"));
              const inner = cell[1] ?? "";
              const type = /\bt="([^"]*)"/.exec(head)?.[1] ?? "";
              if (type === "s") {
                const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
                const idx = Number(v);
                return Number.isInteger(idx) ? (shared[idx] ?? "") : "";
              }
              if (type === "inlineStr") return tagTexts(inner, "t").join("");
              const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
              return decodeXmlEntities(v);
            })
            .join("\t");
        })
        .filter((line) => line.trim().length > 0);
      const body = rows.join("\n").trim();
      return body ? "第 " + (index + 1) + " 张表\n" + body : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
