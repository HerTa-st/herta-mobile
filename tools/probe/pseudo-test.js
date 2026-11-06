(() => {
  const mk = (id, css) => { const d = document.createElement('div'); d.id = id; d.style.cssText = css; document.body.appendChild(d); return d; };
  const box = mk('__probe', 'position:fixed;left:150px;top:300px;width:40px;height:40px;background:rgba(255,0,0,0.15);z-index:99999');
  const st = document.createElement('style');
  st.textContent = '#__probe::after{content:"";position:absolute;inset:-20px;background:rgba(0,0,255,0.001)}';
  document.head.appendChild(st);
  const at = (x, y) => { const t = document.elementFromPoint(x, y); return t ? (t.id || t.className || t.tagName) : 'null'; };
  const res = {
    center: at(170, 320),
    above15: at(170, 305),
    below15: at(170, 335),
    left15: at(155, 320),
  };
  box.remove(); st.remove();
  // 真按钮：直接量 composer 三键的上下扩展到底被谁接住
  const btns = ['.composerEmoji', '.composerFile', '.composerSend', '.railHandle'].map((sel) => {
    const el = document.querySelector(sel); if (!el) return { sel, missing: true };
    const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const names = [-10, -6, 6, 10].map((d) => { const t = document.elementFromPoint(cx, cy + d); return d + ':' + (t ? (t === el ? 'self' : (el.contains(t) ? 'child' : ((t.className && String(t.className).slice(0, 18)) || t.tagName))) : 'null'); });
    return { sel, box: [Math.round(r.width), Math.round(r.height)], vertical: names };
  });
  return JSON.stringify({ pseudoTest: res, buttons: btns }, null, 1);
})()