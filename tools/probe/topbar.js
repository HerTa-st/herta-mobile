(() => {
  const sels = ['.iconBtn', '.moodChip', '.themeToggle', '.topAvatarBtn', '.railNav button', '.railFoot button', '.railMark', '.railNew', '.composerSend', '.composerEmoji', '.composerFile', '.railHandle'];
  const hit = (el) => {
    const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const own = (x, y) => { const t = document.elementFromPoint(x, y); return t === el || (t && el.contains(t)); };
    const scan = (dx, dy) => { let d = 0; for (let i = 1; i <= 30; i++) { if (own(cx + dx * i, cy + dy * i)) d = i; else break; } return d; };
    return { w: Math.round(scan(-1,0)+scan(1,0)+r.width), h: Math.round(scan(0,-1)+scan(0,1)+r.height) };
  };
  const out = {};
  for (const s of sels) {
    const el = document.querySelector(s);
    if (!el) { out[s] = 'missing'; continue; }
    const r = el.getBoundingClientRect();
    out[s] = { box: [Math.round(r.width), Math.round(r.height)], hit: hit(el), after: (getComputedStyle(el, '::after').content !== 'none') };
  }
  return JSON.stringify(out, null, 1);
})()