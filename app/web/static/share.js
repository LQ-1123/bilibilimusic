/* 分享（#25）：正向系统分享面板 + 反向接收分享文本。
 *
 * 正向降级链：BiliMusicNative.shareText（Android 原生面板）→ navigator.share →
 *   navigator.clipboard → execCommand → 弹窗展示链接。
 * 约束：任何一步失败都不静默——最后一环一定把可复制的链接摆到用户面前。
 * 反向：系统分享面板里选 BiliMusic → MainActivity 把文本交给 window.__receiveShare()
 *   → POST /api/imports/batch（后端已能解析分享文本、b23.tv 短链、收藏夹/合集链接）。
 */
(function () {
  "use strict";

  function toast(msg) {
    if (window.__toast) window.__toast(msg);
  }

  /** 复制文本：局域网 http 是非安全上下文，navigator.clipboard 不存在，退回 execCommand。 */
  function copyText(text) {
    function legacy() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "readonly");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return !!ok;
      } catch (e) {
        return false;
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, legacy);
    }
    return Promise.resolve(legacy());
  }
  window.__copyText = copyText;

  function showLink(title, url) {
    if (window.__promptModal) {
      window.__promptModal(title || "分享链接", { value: url });
      return "show";
    }
    toast(url);
    return "toast";
  }

  /** 分享入口：单曲 / 歌单 / 专辑合集 / UP 主页 全部走这里。
   *  opts: {title, text, url}；返回 Promise<"native"|"share"|"copy"|"show"|"toast"|"abort"|"none">。 */
  window.__share = function (opts) {
    opts = opts || {};
    var title = opts.title || "";
    var text = opts.text || "";
    var url = opts.url || "";
    if (!url) {
      toast("暂时拿不到分享链接");
      return Promise.resolve("none");
    }

    var native = window.BiliMusicNative;
    if (native && typeof native.shareText === "function") {
      try {
        native.shareText(title, text, url);
        toast("已打开系统分享");
        return Promise.resolve("native");
      } catch (e) {
        /* 桥调用失败：继续走 Web 方案，不打断用户 */
      }
    }

    function fallback() {
      var payload = text ? text + " " + url : url;
      return copyText(payload).then(function (ok) {
        if (ok) {
          toast("链接已复制 · 粘贴给朋友即可");
          return "copy";
        }
        return showLink(title, url);
      });
    }

    if (navigator.share) {
      return navigator.share({ title: title, text: text, url: url }).then(
        function () { return "share"; },
        function (err) {
          if (err && err.name === "AbortError") return "abort"; // 用户自己取消：不打扰
          return fallback();
        }
      );
    }
    return fallback();
  };

  /** 反向分享：Android 收到 ACTION_SEND 文本后调用（MainActivity.flushShare）。 */
  window.__receiveShare = function (text) {
    text = String(text == null ? "" : text).trim();
    if (!text) return;
    if (document.body.dataset.auth !== "1") {
      // 未登录时导入会失败：先说清原因，再把登录弹窗摆出来（不静默失败）
      toast("请先登录 B 站账号，再重新分享一次");
      if (window.openLogin) window.openLogin();
      return;
    }
    // 先做一次轻量预检：B 站分享文本一定带链接或 BV/av 号；否则直接说清，不排一个注定失败的任务
    if (!/(bilibili\.com|b23\.tv|favlist|collectiondetail|sid=\d+|BV[0-9A-Za-z]{10}|(^|\D)av\d{3,})/i.test(text)) {
      toast("这段内容里没识别到 B 站链接");
      return;
    }
    toast("正在识别分享内容…");
    fetch("/api/imports/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: text, playlistId: 0 }),
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: r.ok, data: data }; });
      })
      .then(function (res) {
        if (!res.ok) {
          toast(res.data.detail || "没能识别这段分享内容");
          return;
        }
        var mode = res.data.mode;
        if (mode === "batch") {
          toast("已开始导入收藏夹「" + (res.data.folderTitle || "") + "」共 " + (res.data.total || 0) + " 首");
        } else if (mode === "series") {
          toast("已开始导入合集，进度见任务列表");
        } else {
          toast("已加入导入队列");
        }
        if (window.htmx) window.htmx.trigger(document.body, "refreshSongs");
      })
      .catch(function () { toast("网络错误，导入失败"); });
  };
})();
