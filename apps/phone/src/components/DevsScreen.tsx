import { splitCredits, type CreditsDoc } from "../credits.ts";
import { CreditRow, CreditsScreen, SectionHead } from "./CreditsPage.tsx";

/**
 * 开发人员 + 灵感与帮助。
 *
 * 三条不做：不写提交数、不做贡献排行榜、不把「给过点子的人」混进开发名单。
 * 「取材自」（kind=work）与「点子来自」（kind=idea）两段措辞不同：
 * 作品是「取材」、人是「谢谢 TA 想到了这个」。
 */
export function DevsScreen({ onClose }: { onClose(): void }) {
  return (
    <CreditsScreen
      title="开发人员"
      subtitle="谁写的代码 · 以及灵感从哪来"
      badge="名单来自网站"
      onClose={onClose}
    >
      {(doc) => <DevsBody doc={doc} />}
    </CreditsScreen>
  );
}

function DevsBody({ doc }: { doc: CreditsDoc }) {
  const { works, ideas } = splitCredits(doc.credits);

  return (
    <>
      <section className="ss-card">
        <SectionHead hint={doc.devs.length > 0 ? doc.devs.length + " 人" : "名单"}>开发人员</SectionHead>
        {doc.devs.length === 0 ? (
          <p className="cr-empty" data-part="empty-state">
            这份名单里没写开发人员。
          </p>
        ) : (
          doc.devs.map((dev, i) => (
            <CreditRow key={"dev:" + dev.name + ":" + i} name={dev.name} detail={dev.role} />
          ))
        )}
      </section>

      <p className="ss-hint">只写作者本人和每人负责哪块，不写提交数——这不是贡献排行榜。</p>

      <section className="ss-card">
        <SectionHead hint="取材自">灵感与帮助</SectionHead>
        {works.length === 0 ? (
          <p className="cr-empty" data-part="empty-state">
            还没有写「取材自」。人格、叙述、开屏若取自别处，会记在这一段。
          </p>
        ) : (
          works.map((work, i) => (
            <CreditRow
              key={"work:" + work.name + ":" + i}
              name={work.name}
              detail={work.author ? "作者 " + work.author : "作者不详"}
              tag="取材"
            />
          ))
        )}
      </section>

      <section className="ss-card">
        <SectionHead hint="点子来自">灵感与帮助 · 之二</SectionHead>
        {ideas.length === 0 ? (
          <p className="cr-empty" data-part="empty-state">
            还没有记下点子来自谁。给过点子的人会出现在这一段，写清 TA 想到了什么。
          </p>
        ) : (
          ideas.map((idea, i) => (
            <CreditRow
              key={"idea:" + idea.name + ":" + i}
              name={idea.name}
              detail="谢谢 TA 想到了这个"
              tag="点子"
            />
          ))
        )}
      </section>

      <p className="ss-hint">
        取材自：被取材的作品与作者。点子来自：给过点子的人。两类分开写，也都不混进上面的开发名单。
        dsh-herta 插件的开发人员与授权在插件站自己的页面，和这份不是一回事。
      </p>
    </>
  );
}
