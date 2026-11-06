(async () => {
  const T = 'memory';
  const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const comp = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  function f(x) { const s = x / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  function effBg(el) { let cur = el, acc = null; while (cur) { const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a > 0) acc = acc ? comp(acc, c) : c; if (acc && acc.a >= 0.999) return acc; cur = cur.parentElement; } return acc || { r: 255, g: 255, b: 255, a: 1 }; }
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > -50 && r.top < innerHeight + 200; };
  function hitBox(el) {
    const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const own = (x, y) => { const t = document.elementFromPoint(x, y); return t === el || (t && el.contains(t)); };
    const scan = (dx, dy) => { let d = 0; for (let i = 1; i <= 40; i++) { if (own(cx + dx * i, cy + dy * i)) d = i; else break; } return d; };
    return { w: Math.round(scan(-1,0)+scan(1,0)+r.width), h: Math.round(scan(0,-1)+scan(0,1)+r.height) };
  }
  function measure(name) {
    const targets = [...document.querySelectorAll('button,a,[role=button],input,select,textarea')].filter(vis).map((el) => {
      const r = el.getBoundingClientRect(); const hb = hitBox(el);
      return { cls: (el.className && String(el.className).slice(0, 28)) || '', label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 16), w: Math.round(r.width), h: Math.round(r.height), hitW: hb.w, hitH: hb.h };
    });
    const seen = new Set(); const contrast = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el)) continue;
      const txt = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join('');
      if (!txt) continue;
      const cs = getComputedStyle(el); const fg = parse(cs.color); if (!fg) continue;
      const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 600;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const bg = effBg(el); const rr = ratio(comp(fg, bg), bg);
      const key = cs.color + '|' + JSON.stringify(bg) + '|' + size; if (seen.has(key)) continue; seen.add(key);
      contrast.push({ text: txt.slice(0, 18), ratio: Math.round(rr * 100) / 100, need, pass: rr >= need });
    }
    return { name, overflowX: document.documentElement.scrollWidth - innerWidth, targets: targets.length, small: targets.filter((t) => t.hitW < 44 || t.hitH < 44), contrastFail: contrast.filter((c) => !c.pass) };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rail = (t) => { const b = [...document.querySelectorAll('[data-part="rail-item"]')].find((x) => (x.getAttribute('aria-label') || x.textContent || '').includes(t)); if (b) { b.click(); return true; } return false; };
  if (T !== 'chat') {
    if (T === 'drawer') { const b = document.querySelector('[aria-label="会话"]'); if (b) b.click(); }
    else rail(T === 'memory' ? '记忆' : T === 'broadcast' ? '播报' : T === 'coin' ? '黑塔币' : '设置');
    await sleep(T === 'drawer' ? 500 : 1300);
  } else { await sleep(200); }
  return JSON.stringify(measure(T), null, 1);
})()