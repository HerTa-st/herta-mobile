// 把 [data-feedback] / [data-query] / [data-mirrors] / [data-repo] / [data-download] 渲染出来；没配就降级，不出死链
(function () {
  var cfg = window.HERTA_SITE || {};

  function apply(attr, url, hideWhenEmpty) {
    var links = document.querySelectorAll("[" + attr + "]");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (url) {
        a.setAttribute("href", url);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noreferrer");
      } else if (hideWhenEmpty) {
        a.style.display = "none";
      } else {
        a.setAttribute("href", a.getAttribute("data-fallback") || "issues.html");
        a.setAttribute("title", "表单还没配，先看已知问题");
      }
    }
  }

  apply("data-feedback", (cfg.feedback || "").trim(), false);
  apply("data-query", (cfg.feedbackQuery || "").trim(), true);
  apply("data-repo", (cfg.repo || "").trim(), true);
  apply("data-download", (cfg.download || "").trim(), true);

  // 备用下载：渲染成「蓝奏云（提取码 bqyf）· 夸克网盘（提取码 J4hR）」
  var box = document.querySelector("[data-mirrors]");
  var list = cfg.mirrors || [];
  if (box) {
    if (!list.length) {
      var p = box.closest("p");
      if (p) p.style.display = "none"; else box.style.display = "none";
    } else {
      box.textContent = "";
      for (var k = 0; k < list.length; k++) {
        var m = list[k];
        if (k > 0) box.appendChild(document.createTextNode(" · "));
        var a = document.createElement("a");
        a.href = m.url;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = m.name;
        box.appendChild(a);
        if (m.code) box.appendChild(document.createTextNode("（提取码 " + m.code + "）"));
      }
    }
  }
})();
