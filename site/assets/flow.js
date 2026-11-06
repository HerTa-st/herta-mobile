// 首屏 ASCII 竖流：与 App 开屏同一个语言（白底墨字）
(function () {
  var canvas = document.getElementById('flow');
  if (!canvas) return;
  var ctx = canvas.getContext('2d', { alpha: true });
  var RAMP = ' .:-=+*#%@';
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  var cols = 0, rows = 0, stepX = 13, stepY = 17;
  var SPEED = 2.0;        // 整体流速倍数：想再快就调这个数
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function layout() {
    var r = canvas.getBoundingClientRect();
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(r.width / stepX);
    rows = Math.ceil(r.height / stepY);
    ctx.font = '12px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'top';
  }

  function hash(n) {
    var x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  function draw(t) {
    var r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    for (var c = 0; c < cols; c++) {
      var speed = (0.5 + hash(c + 1) * 1.7) * SPEED;
      // 每列给一个初始偏移，首帧就有字，不会先空几秒
      var phase = ((t * speed + hash(c + 9) * (rows + 24)) % (rows + 24)) - 12;
      var tail = 6 + Math.floor(hash(c + 5) * 8);
      for (var i = 0; i < tail; i++) {
        var y = Math.floor(phase - i);
        if (y < 0 || y >= rows) continue;
        var a = 0.26 * (1 - i / tail);
        if (a <= 0.01) continue;
        var ch = RAMP[Math.min(9, Math.floor((1 - i / tail) * 9))];
        if (ch === ' ') continue;
        ctx.fillStyle = 'rgba(17, 20, 23, ' + a.toFixed(3) + ')';
        ctx.fillText(ch, c * stepX, y * stepY);
      }
    }
  }

  var start = 0;
  function loop(ts) {
    if (!start) start = ts;
    draw((ts - start) / 1000);
    requestAnimationFrame(loop);
  }

  layout();
  window.addEventListener('resize', function () {
    layout();
    if (reduce) draw(0);
  });
  if (reduce) {
    // 等浏览器把首屏布局算完再画一帧静态的，避免在 0 高度的画布上画空
    requestAnimationFrame(function () {
      layout();
      draw(0);
    });
  } else {
    requestAnimationFrame(loop);
  }
})();
