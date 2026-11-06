(() => {
  const out = {};
  const pick = (sel) => document.querySelector(sel);
  const probe = (sel) => {
    const el = pick(sel); if (!el) return { sel, missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const after = getComputedStyle(el, '::after');
    const pts = [];
    for (const d of [3, 5, 7]) {
      const t = document.elementFromPoint(r.left + r.width / 2, r.top - d);
      pts.push(d + ':' + (t ? (t === el ? 'self' : (el.contains(t) ? 'child' : (t.className || t.tagName))) : 'null'));
    }
    return { sel, box: [Math.round(r.width), Math.round(r.height)], pos: cs.position, overflow: cs.overflow, afterContent: after.content, afterInset: after.top + '/' + after.right + '/' + after.bottom + '/' + after.left, afterMin: after.minWidth + 'x' + after.minHeight, above: pts };
  };
  out.composerSend = probe('.composerSend');
  out.composerEmoji = probe('.composerEmoji');
  out.themeToggle = probe('.themeToggle');
  out.railItem = probe('.railNav button');
  out.iconBtn = probe('.iconBtn');
  out.railHandle = probe('.railHandle');
  out.cssHasComposerAfter = [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.cssText && r.cssText.includes('.composerSend::after')); } catch (e) { return false; } });
  return JSON.stringify(out, null, 1);
})()