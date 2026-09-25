/* Cantonese learning layer for BiliMusic's existing search, player and lyric timeline. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var panel = $("lyrics-panel");
  var state = { open: false, key: "", lines: [], timed: false, index: 0,
    mastered: new Set(), pinyin: true, loop: false, recorder: null,
    stream: null, chunks: [], recordUrl: "", recordingLine: -1, character: null };
  var replay = new Audio();
  var TONE_NAMES = { 1: "阴平", 2: "阴上", 3: "阴去", 4: "阳平", 5: "阳上", 6: "阳去" };
  var cantoneseVoice = null;
  var voiceWarmed = false;
  var speechRequest = 0;
  var speechTimer = 0;
  var speechSlowTimer = 0;

  function refreshVoice() {
    if (!window.speechSynthesis) return null;
    var voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return cantoneseVoice;
    var cantonese = voices.filter(function (voice) { return /^(zh-HK|yue)/i.test(voice.lang); });
    cantoneseVoice = cantonese.find(function (voice) { return voice.localService; }) || cantonese[0] || null;
    return cantoneseVoice;
  }
  if (window.speechSynthesis) {
    refreshVoice();
    if (window.speechSynthesis.addEventListener) window.speechSynthesis.addEventListener("voiceschanged", refreshVoice);
  }
  function stopSpeech() {
    speechRequest++;
    clearTimeout(speechTimer);
    clearTimeout(speechSlowTimer);
    speechTimer = 0;
    speechSlowTimer = 0;
    var synth = window.speechSynthesis;
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
  }
  function warmSpeech() {
    var synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance || !cantoneseVoice || voiceWarmed || synth.speaking || synth.pending) return;
    voiceWarmed = true;
    // Entering study mode is a user gesture: initialize the selected voice before the first tap.
    var warmup = new SpeechSynthesisUtterance("啊");
    warmup.lang = "zh-HK";
    warmup.voice = cantoneseVoice;
    warmup.volume = 0;
    warmup.onerror = function () { voiceWarmed = false; };
    try { synth.speak(warmup); } catch (e) { voiceWarmed = false; }
  }

  function status(message) { $("learn-status").textContent = message; }
  function progressKey() { return "bm-learning:" + (document.body.dataset.mid || "guest") + ":" + state.key; }
  function loadProgress() {
    try { state.mastered = new Set(JSON.parse(localStorage.getItem(progressKey()) || "[]")); }
    catch (e) { state.mastered = new Set(); }
  }
  function saveProgress() {
    try { localStorage.setItem(progressKey(), JSON.stringify(Array.from(state.mastered))); }
    catch (e) { /* Private browsing may disable storage. */ }
  }
  function pinyin(text) {
    if (!window.ToJyutping) return "粤拼词库未加载";
    try { return window.ToJyutping.getJyutpingText(text) || "暂无粤拼"; }
    catch (e) { return "暂无粤拼"; }
  }
  function stopRecording() {
    if (state.recorder && state.recorder.state === "recording") state.recorder.stop();
    if (state.stream) state.stream.getTracks().forEach(function (track) { track.stop(); });
    state.stream = null;
    $("learn-record").textContent = "◉ 跟读";
    $("learn-record").classList.remove("recording");
  }
  function resetRecording() {
    state.recordingLine = -1;
    stopRecording();
    if (state.recordUrl) URL.revokeObjectURL(state.recordUrl);
    state.recordUrl = "";
    $("learn-replay").hidden = true;
  }
  function setOpen(open) {
    if (open && window.BiliKaraoke && BiliKaraoke.isRecording()) {
      status("请先结束录歌，再切换到学习模式。");
      return;
    }
    if (open && window.BiliKaraoke) BiliKaraoke.close();
    state.open = open;
    panel.classList.toggle("learning-mode", open);
    $("learning-card").hidden = !open;
    document.querySelectorAll(".learn-toggle").forEach(function (button) {
      button.setAttribute("aria-pressed", String(open));
      button.classList.toggle("on", open);
    });
    if (open) {
      if (window.__setQueueView) window.__setQueueView(false);
      panel.classList.add("showlyrics");
      refreshVoice();
      warmSpeech();
      decorate();
      render();
    } else {
      state.loop = false;
      stopRecording();
      stopSpeech();
      // Existing lyric renderer owns the text; remove only our ruby annotation.
      $("lyrics-scroll").querySelectorAll(".l-line").forEach(function (line) {
        var item = state.lines[Number(line.dataset.idx)];
        if (item) line.textContent = item.text || "· · ·";
        line.classList.remove("learning-selected", "learning-mastered");
      });
    }
  }
  function render() {
    var line = state.lines[state.index];
    $("learn-number").textContent = line ? String(state.index + 1).padStart(2, "0") + " / " + String(state.lines.length).padStart(2, "0") : "00 / 00";
    $("learn-text").textContent = line ? (line.text || "· · ·") : "选择一句歌词开始学习";
    $("learn-jyutping").textContent = line && state.pinyin ? pinyin(line.text) : "";
    $("learn-jyutping").hidden = !state.pinyin;
    var character = state.character;
    $("learn-char-hint").hidden = !!character;
    $("learn-char-box").hidden = !character;
    if (character) {
      $("learn-char-glyph").textContent = character.glyph;
      $("learn-char-roman").textContent = character.jyutping;
      var tone = Number((character.jyutping.match(/[1-6]$/) || [])[0]);
      $("learn-char-tone").textContent = tone ? "第" + tone + "声 · " + TONE_NAMES[tone] : "本句读音";
    }
    $("learn-pinyin").textContent = "粤拼：" + (state.pinyin ? "开" : "关");
    $("learn-pinyin").setAttribute("aria-pressed", String(state.pinyin));
    $("learn-loop").textContent = "单句循环：" + (state.loop ? "开" : "关");
    $("learn-loop").setAttribute("aria-pressed", String(state.loop));
    $("learn-mastered").textContent = state.mastered.has(state.index) ? "✓ 已掌握" : "○ 学会了";
    $("learn-mastered").setAttribute("aria-pressed", String(state.mastered.has(state.index)));
    $("learn-progress-label").textContent = state.mastered.size + " / " + state.lines.length + " 句已掌握";
    $("learn-progress-bar").style.width = (state.lines.length ? state.mastered.size / state.lines.length * 100 : 0) + "%";
    ["learn-speak", "learn-record", "learn-mastered"].forEach(function (id) { $(id).disabled = !line; });
    $("lyrics-scroll").querySelectorAll(".l-line").forEach(function (node) {
      var idx = Number(node.dataset.idx);
      node.classList.toggle("learning-selected", state.open && idx === state.index);
      node.classList.toggle("learning-mastered", state.open && state.mastered.has(idx));
      node.querySelectorAll(".learn-char").forEach(function (target) {
        target.classList.toggle("selected", !!state.character && state.character.lineIndex === idx && state.character.characterIndex === Number(target.dataset.charIndex));
      });
    });
  }
  function decorate() {
    if (!state.open) return;
    $("lyrics-scroll").querySelectorAll(".l-line").forEach(function (node) {
      var item = state.lines[Number(node.dataset.idx)];
      if (!item) return;
      node.textContent = "";
      var text = item.text || "· · ·";
      var pairs;
      try { pairs = window.ToJyutping ? window.ToJyutping.getJyutpingList(text) : Array.from(text).map(function (c) { return [c, null]; }); }
      catch (e) { pairs = Array.from(text).map(function (c) { return [c, null]; }); }
      pairs.forEach(function (pair, index) {
        if (!pair[1]) { node.appendChild(document.createTextNode(pair[0])); return; }
        var target = document.createElement("span");
        target.className = "learn-char";
        target.dataset.charIndex = String(index);
        target.setAttribute("role", "button");
        target.setAttribute("tabindex", "0");
        target.setAttribute("aria-label", pair[0] + "，粤拼 " + pair[1] + "，点击听读音");
        if (!state.pinyin) {
          target.textContent = pair[0];
          node.appendChild(target);
          return;
        }
        var ruby = document.createElement("ruby");
        ruby.textContent = pair[0];
        var rt = document.createElement("rt");
        rt.textContent = pair[1];
        ruby.appendChild(rt);
        target.appendChild(ruby);
        node.appendChild(target);
      });
    });
    render();
  }
  function select(index) {
    if (!state.open || !state.lines[index]) return;
    if (state.index !== index) state.character = null;
    state.index = index;
    render();
  }
  function selectCharacter(lineIndex, characterIndex) {
    var line = state.lines[lineIndex];
    if (!state.open || !line || !window.ToJyutping) return;
    var pair;
    try { pair = window.ToJyutping.getJyutpingList(line.text)[characterIndex]; }
    catch (e) { return; }
    if (!pair || !pair[1]) return;
    state.index = lineIndex;
    state.character = { glyph: pair[0], jyutping: pair[1], lineIndex: lineIndex, characterIndex: characterIndex };
    render();
    speakCharacter();
  }
  function time(now, playbackIndex) {
    if (!state.open || !state.lines.length) return;
    if (state.loop && state.timed) {
      var current = state.lines[state.index];
      var next = state.lines[state.index + 1];
      var end = next ? next.t : (window.__learningDuration ? window.__learningDuration() : 0);
      if (current && current.t >= 0 && end > current.t && now >= end - 0.08) {
        if (window.__learningSeek) window.__learningSeek(current.t);
      }
      return;
    }
    if (playbackIndex !== state.index && state.lines[playbackIndex]) {
      state.index = playbackIndex;
      state.character = null;
      render();
    }
  }
  function speakText(text, kind) {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) { status("当前浏览器不支持语音朗读。"); return; }
    var synth = window.speechSynthesis;
    clearTimeout(speechTimer);
    clearTimeout(speechSlowTimer);
    var request = ++speechRequest;
    var busy = synth.speaking || synth.pending;
    if (busy) synth.cancel(); // Do not cancel an idle engine: Chromium can delay the next utterance.
    var utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-HK";
    utterance.rate = kind === "char" ? 0.72 : 0.85;
    utterance.voice = refreshVoice();
    status(utterance.voice ? "准备发音…" : "未检测到粤语语音；浏览器可能使用默认读音。安装粤语语音包可改善发音。");
    utterance.onstart = function () {
      if (request !== speechRequest) return;
      clearTimeout(speechSlowTimer);
      status(kind === "char" ? "正在朗读这个字，可点「再听」重复。" : "正在朗读这句，听完试着跟读。");
    };
    utterance.onerror = function () {
      if (request === speechRequest) status("朗读失败，请检查浏览器语音设置。");
    };
    speechSlowTimer = setTimeout(function () {
      if (request === speechRequest && utterance.voice) status("粤语声线正在加载；首次朗读可能稍慢。");
    }, 1000);
    var start = function () {
      if (request !== speechRequest) return;
      try {
        if (synth.paused) synth.resume();
        synth.speak(utterance);
      } catch (e) { status("朗读启动失败，请重试。"); }
    };
    if (busy) speechTimer = setTimeout(start, 40);
    else start();
  }
  function speak() {
    var line = state.lines[state.index];
    if (!line) return;
    speakText(line.text, "line");
  }
  function speakCharacter() {
    if (state.character) speakText(state.character.glyph, "char");
  }
  function record() {
    if (state.recorder && state.recorder.state === "recording") { stopRecording(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      status("当前浏览器不支持录音，请使用新版浏览器和 HTTPS／本机地址。"); return;
    }
    var lineIndex = state.index;
    var songKey = state.key;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      if (!state.open || state.key !== songKey) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        return;
      }
      state.stream = stream;
      state.chunks = [];
      var recorder = new MediaRecorder(stream);
      state.recorder = recorder;
      state.recordingLine = lineIndex;
      recorder.ondataavailable = function (event) { if (event.data.size) state.chunks.push(event.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (track) { track.stop(); });
        if (!state.chunks.length || state.recordingLine !== lineIndex || !state.open) return;
        if (state.recordUrl) URL.revokeObjectURL(state.recordUrl);
        state.recordUrl = URL.createObjectURL(new Blob(state.chunks, { type: recorder.mimeType || "audio/webm" }));
        replay.src = state.recordUrl;
        $("learn-replay").hidden = false;
        status("录好了。回听并对比原句发音。");
      };
      recorder.start();
      $("learn-record").textContent = "■ 结束";
      $("learn-record").classList.add("recording");
      status("正在录音，再点一次结束。");
    }).catch(function () { status("麦克风未启用，请检查浏览器权限。"); });
  }

  document.querySelectorAll(".learn-toggle").forEach(function (button) {
    button.addEventListener("click", function () { setOpen(!state.open); });
  });
  $("learn-close").addEventListener("click", function () { setOpen(false); });
  $("learn-speak").addEventListener("click", speak);
  $("learn-char-speak").addEventListener("click", speakCharacter);
  $("lyrics-scroll").addEventListener("click", function (event) {
    var target = event.target.closest(".learn-char");
    if (!target || !state.open) return;
    event.preventDefault();
    event.stopImmediatePropagation(); // A character click should not also seek the full song.
    var line = target.closest(".l-line");
    if (line) selectCharacter(Number(line.dataset.idx), Number(target.dataset.charIndex));
  });
  $("lyrics-scroll").addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var target = event.target.closest(".learn-char");
    if (!target || !state.open) return;
    event.preventDefault();
    var line = target.closest(".l-line");
    if (line) selectCharacter(Number(line.dataset.idx), Number(target.dataset.charIndex));
  });
  $("learn-record").addEventListener("click", record);
  $("learn-replay").addEventListener("click", function () { replay.play().catch(function () { status("录音回放失败。"); }); });
  $("learn-pinyin").addEventListener("click", function () { state.pinyin = !state.pinyin; decorate(); });
  $("learn-loop").addEventListener("click", function () {
    if (!state.timed || !state.lines[state.index] || state.lines[state.index].t < 0) {
      status("单句循环需要带时间轴的歌词。"); return;
    }
    if (!state.loop && (!window.__learningSeek || !window.__learningSeek(state.lines[state.index].t))) {
      status("远端串流时请切回本机播放，再使用单句循环。"); return;
    }
    state.loop = !state.loop;
    render();
  });
  $("learn-mastered").addEventListener("click", function () {
    if (!state.lines[state.index]) return;
    if (state.mastered.has(state.index)) state.mastered.delete(state.index);
    else state.mastered.add(state.index);
    saveProgress(); render();
  });
  window.addEventListener("beforeunload", resetRecording);

  window.BiliLearning = {
    loading: function (meta) {
      resetRecording();
      state.key = meta.key;
      state.lines = [];
      state.timed = false;
      state.index = 0;
      state.character = null;
      state.loop = false;
      state.mastered = new Set();
      status("正在加载歌词…"); render();
    },
    setLyrics: function (meta, lines, timed) {
      state.key = meta.key;
      state.lines = lines;
      state.timed = timed;
      state.index = 0;
      state.character = null;
      loadProgress();
      state.mastered = new Set(Array.from(state.mastered).filter(function (i) { return Number.isInteger(i) && i >= 0 && i < lines.length; }));
      decorate(); render();
      status(lines.length ? "点击歌词选句，朗读、跟读，再标记掌握。" : "这首歌暂时没有可学的歌词。");
    },
    error: function () { state.lines = []; state.timed = false; state.character = null; render(); status("歌词加载失败，请点重试。"); },
    decorate: decorate,
    select: select,
    time: time,
    isOpen: function () { return state.open; },
    close: function () { setOpen(false); },
  };
})();
