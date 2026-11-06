(() => {
  const el = document.querySelector('.railNav button');
  const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const name = (t) => t ? (t === el ? 'self' : (el.contains(t) ? 'child' : ((t.className && String(t.className).slice(0,20)) || t.tagName))) : 'null';
  const rows = [];
  for (const off of [-30, -25, -18, -12, -10, -6, 0, 6, 10, 12, 18, 25, 30]) {
    rows.push(off + ':' + name(document.elementFromPoint(cx + off, cy)) + ' / v' + off + ':' + name(document.elementFromPoint(cx, cy + off)));
  }
  return JSON.stringify({ box: [r.left, r.top, r.width, r.height], rows }, null, 1);
})()