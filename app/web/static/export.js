/* 导出为 B 站收藏夹：弹窗交互 + 进度轮询。
   所有请求均为同源静态路径；任务 id 由服务端生成（12 位 hex），入参前先做格式校验。 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var exportModal = $("export-modal");
  if (!exportModal) return;

  var exportTimer = null;
  var exportId = null;

  function stopExportPoll() {
    if (exportTimer) { clearInterval(exportTimer); exportTimer = null; }
  }

  function resetExportUI() {
    $("export-progress").classList.add("hidden");
    $("export-result").classList.add("hidden");
    $("export-failures").classList.add("hidden");
    $("export-status").textContent = "准备中…";
    $("export-fill").style.width = "0%";
    $("btn-export-start").disabled = false;
    stopExportPoll();
  }

  $("btn-export").addEventListener("click", function () {
    resetExportUI();
    exportModal.classList.remove("hidden");
  });

  $("btn-export-close").addEventListener("click", function () {
    exportModal.classList.add("hidden");
    stopExportPoll();
  });

  exportModal.addEventListener("click", function (e) {
    if (e.target === exportModal) {
      exportModal.classList.add("hidden");
      stopExportPoll();
    }
  });

  $("btn-export-start").addEventListener("click", function () {
    $("btn-export-start").disabled = true;
    fetch("/api/exports", { method: "POST" })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, d: d }; });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.detail || "提交失败");
        var id = String(res.d.exportId || "");
        if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("非法的任务 id");
        exportId = id;
        $("export-progress").classList.remove("hidden");
        exportTimer = setInterval(pollExport, 1200);
      })
      .catch(function (e) {
        $("export-progress").classList.remove("hidden");
        $("export-status").textContent = e.message;
      });
  });

  function pollExport() {
    if (!exportId) return;
    // 静态路径 + 请求体传 id，URL 恒为字面量
    fetch("/api/exports/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exportId: exportId })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
        $("export-fill").style.width = pct + "%";
        $("export-status").textContent = d.status === "exporting"
          ? "收藏中 " + d.done + "/" + d.total
          : d.status === "pending" ? "准备中…" : "完成 " + d.done + "/" + d.total;
        if (d.status === "done" || d.status === "failed") {
          stopExportPoll();
          if (d.link) {
            $("export-link").textContent = d.link;
            $("export-link").href = d.link;
            $("export-result").classList.remove("hidden");
          }
          if (d.status === "failed" && d.error) {
            $("export-status").textContent = "失败：" + d.error;
          }
          if (d.failures && d.failures.length) {
            var box = $("export-failures");
            box.innerHTML = d.failures.map(function (f) {
              return "✕ " + f.bvid + "：" + f.error;
            }).join("<br>");
            box.classList.remove("hidden");
          }
        }
      });
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  $("btn-copy-link").addEventListener("click", function () {
    var link = $("export-link").textContent;
    var done = function () {
      $("btn-copy-link").textContent = "已复制";
      setTimeout(function () { $("btn-copy-link").textContent = "复制链接"; }, 1500);
    };
    // #25：统一走 share.js 的复制降级链（clipboard → execCommand），少一份重复实现
    if (window.__copyText) { window.__copyText(link).then(done); return; }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(link).then(done).catch(function () {
        fallbackCopy(link);
        done();
      });
    } else {
      fallbackCopy(link);
      done();
    }
  });

  // ---------- 退出登录（账号页） ----------
  var logoutBtn = $("btn-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", function () {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      }).then(function () { location.href = "/"; });
    });
  }
})();
