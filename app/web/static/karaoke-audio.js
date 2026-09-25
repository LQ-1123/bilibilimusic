/* Record the locally playing song together with the selected microphone. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var panel = $("lyrics-panel");
  var state = {
    open: false, starting: false, recording: false, recorder: null, chunks: [],
    microphone: null, songStream: null, context: null, media: null,
    songGain: null, micGain: null, timer: 0, startedAt: 0,
    resultUrl: "", error: "", onSongEnded: null,
  };

  function status(message, isError) {
    var el = $("karaoke-status");
    el.textContent = message;
    el.classList.toggle("is-error", !!isError);
  }
  function timeText(seconds) {
    var n = Math.max(0, Math.floor(seconds));
    return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
  }
  function setButtons() {
    $("karaoke-start").disabled = state.starting || state.recording;
    $("karaoke-stop").disabled = !state.recording;
    $("karaoke-microphone").disabled = state.starting || state.recording;
    $("karaoke-refresh").disabled = state.starting || state.recording;
    $("karaoke-card").classList.toggle("is-recording", state.recording);
  }
  function currentInfo() {
    if (!window.BiliPlayer) return null;
    return BiliPlayer.trialInfo() || BiliPlayer.currentSong();
  }
  function setOpen(open) {
    if (!open && (state.starting || state.recording)) {
      status("请先结束录歌，再收起面板。", true);
      return;
    }
    if (open && window.BiliLearning && BiliLearning.close) BiliLearning.close();
    state.open = open;
    panel.classList.toggle("karaoke-mode", open);
    $("karaoke-card").hidden = !open;
    document.querySelectorAll(".karaoke-toggle").forEach(function (button) {
      button.classList.toggle("on", open);
      button.setAttribute("aria-pressed", String(open));
    });
    if (open) {
      if (window.__setQueueView) window.__setQueueView(false);
      panel.classList.add("showlyrics");
      var info = currentInfo();
      status(info ? "当前歌曲：" + (info.title || "未命名") + "。录音默认使用系统输入设备。" : "先播放想唱的伴奏，再开始录歌。", !info);
      refreshMicrophones(false);
    }
  }
  async function refreshMicrophones(requestPermission) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      status("当前浏览器不支持列出麦克风；仍可使用系统默认输入设备。", true);
      return;
    }
    $("karaoke-refresh").disabled = true;
    try {
      if (requestPermission) {
        var permission = await navigator.mediaDevices.getUserMedia({ audio: true });
        permission.getTracks().forEach(function (track) { track.stop(); });
      }
      var chosen = $("karaoke-microphone").value;
      var devices = (await navigator.mediaDevices.enumerateDevices()).filter(function (device) { return device.kind === "audioinput" && device.deviceId !== "default"; });
      var select = $("karaoke-microphone");
      select.replaceChildren(new Option("系统默认输入设备", ""));
      devices.forEach(function (device, index) {
        select.add(new Option(device.label || "麦克风 " + (index + 1), device.deviceId));
      });
      select.value = devices.some(function (device) { return device.deviceId === chosen; }) ? chosen : "";
      if (requestPermission) status("已更新麦克风列表；当前使用" + select.selectedOptions[0].textContent + "。");
    } catch (error) {
      status("读取麦克风失败：" + (error.message || "请检查权限"), true);
    } finally {
      setButtons();
    }
  }
  function setGain(inputId, outputId, node) {
    var value = Number($(inputId).value) / 100;
    $(outputId).textContent = Math.round(value * 100) + "%";
    if (node) node.gain.value = value;
  }
  function recordingOptions() {
    var types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    var mime = types.find(function (type) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type); });
    return mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : { audioBitsPerSecond: 192000 };
  }
  function downloadName(type) {
    var info = currentInfo();
    var title = ((info && info.title) || "录歌").replace(/[\\/:*?"<>|]/g, "-").slice(0, 50);
    var date = new Date();
    var stamp = date.getFullYear() + String(date.getMonth() + 1).padStart(2, "0") + String(date.getDate()).padStart(2, "0") + "-" + String(date.getHours()).padStart(2, "0") + String(date.getMinutes()).padStart(2, "0");
    return title + "-人声混音-" + stamp + (type.indexOf("mp4") >= 0 ? ".m4a" : ".webm");
  }
  function releaseCapture() {
    if (state.media && state.onSongEnded) state.media.removeEventListener("ended", state.onSongEnded);
    if (state.microphone) state.microphone.getTracks().forEach(function (track) { track.stop(); });
    if (state.songStream) state.songStream.getTracks().forEach(function (track) { track.stop(); });
    if (state.context) state.context.close().catch(function () {});
    state.microphone = null;
    state.songStream = null;
    state.context = null;
    state.media = null;
    state.onSongEnded = null;
    state.songGain = null;
    state.micGain = null;
  }
  function finishRecording() {
    clearInterval(state.timer);
    state.timer = 0;
    var recorder = state.recorder;
    var type = (recorder && recorder.mimeType) || "audio/webm";
    var blob = new Blob(state.chunks, { type: type });
    state.recording = false;
    state.starting = false;
    state.recorder = null;
    state.chunks = [];
    releaseCapture();
    setButtons();
    if (state.error) { status(state.error, true); state.error = ""; return; }
    if (!blob.size) { status("录音为空，请确认歌曲正在播放并重试。", true); return; }
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = URL.createObjectURL(blob);
    $("karaoke-preview").src = state.resultUrl;
    $("karaoke-download").href = state.resultUrl;
    $("karaoke-download").download = downloadName(type);
    $("karaoke-result").hidden = false;
    status("录好了：伴奏与麦克风已混音。可以试听并下载。", false);
  }
  function stopRecording(message) {
    if (!state.recorder || state.recorder.state === "inactive") return;
    $("karaoke-stop").disabled = true;
    status(message || "正在生成录音…");
    try { state.recorder.stop(); }
    catch (error) { state.error = "结束录歌失败：" + error.message; finishRecording(); }
  }
  async function startRecording() {
    if (state.starting || state.recording) return;
    var media = window.BiliPlayer && BiliPlayer.activeMedia();
    if (!media || !media.src || media.paused || media.ended) {
      status("请先播放想唱的伴奏，再点开始录歌。", true);
      return;
    }
    if (!media.captureStream || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder || (!window.AudioContext && !window.webkitAudioContext)) {
      status("当前浏览器不支持歌曲与麦克风混录，请用新版 Chrome / Edge 的本机或 HTTPS 页面。", true);
      return;
    }
    state.starting = true;
    state.error = "";
    setButtons();
    status("正在连接所选麦克风…");
    var microphone = null, songStream = null, context = null;
    try {
      var deviceId = $("karaoke-microphone").value;
      var audioOptions = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (deviceId) audioOptions.deviceId = { exact: deviceId };
      microphone = await navigator.mediaDevices.getUserMedia({ audio: audioOptions });
      if (!microphone.getAudioTracks().length) throw new Error("所选麦克风没有音频轨道。");
      if (media.paused || media.ended) throw new Error("歌曲已经停止，请重新播放后录歌。");
      songStream = media.captureStream();
      if (!songStream.getAudioTracks().length) throw new Error("没有获取到歌曲音频；请等待伴奏开始播放后重试。");
      var AudioContextClass = window.AudioContext || window.webkitAudioContext;
      context = new AudioContextClass();
      if (context.state === "suspended") await context.resume();
      var destination = context.createMediaStreamDestination();
      var songGain = context.createGain();
      var micGain = context.createGain();
      setGain("karaoke-song-gain", "karaoke-song-value", songGain);
      setGain("karaoke-mic-gain", "karaoke-mic-value", micGain);
      context.createMediaStreamSource(songStream).connect(songGain).connect(destination);
      context.createMediaStreamSource(microphone).connect(micGain).connect(destination);
      var recorder = new MediaRecorder(destination.stream, recordingOptions());
      state.microphone = microphone;
      state.songStream = songStream;
      state.context = context;
      state.media = media;
      state.songGain = songGain;
      state.micGain = micGain;
      state.recorder = recorder;
      state.chunks = [];
      state.onSongEnded = function () { stopRecording("歌曲已结束，正在保存录音…"); };
      media.addEventListener("ended", state.onSongEnded, { once: true });
      microphone.getAudioTracks()[0].addEventListener("ended", function () { stopRecording("麦克风已断开，正在保存录音…"); }, { once: true });
      recorder.addEventListener("dataavailable", function (event) { if (event.data && event.data.size) state.chunks.push(event.data); });
      recorder.addEventListener("stop", finishRecording, { once: true });
      recorder.addEventListener("error", function () { state.error = "录歌过程中发生错误，请重试。"; stopRecording(); });
      recorder.start(1000);
      if (state.resultUrl) {
        URL.revokeObjectURL(state.resultUrl);
        state.resultUrl = "";
        $("karaoke-preview").removeAttribute("src");
        $("karaoke-result").hidden = true;
      }
      state.startedAt = performance.now();
      $("karaoke-timer").textContent = "00:00";
      state.timer = setInterval(function () { $("karaoke-timer").textContent = timeText((performance.now() - state.startedAt) / 1000); }, 500);
      state.recording = true;
      state.starting = false;
      setButtons();
      status("正在录歌：继续播放伴奏并跟唱，唱完点「结束」。");
      refreshMicrophones(false);
    } catch (error) {
      if (microphone) microphone.getTracks().forEach(function (track) { track.stop(); });
      if (songStream) songStream.getTracks().forEach(function (track) { track.stop(); });
      if (context) context.close().catch(function () {});
      state.starting = false;
      state.recording = false;
      state.recorder = null;
      releaseCapture();
      setButtons();
      status("录歌启动失败：" + (error.message || "检查麦克风权限"), true);
    }
  }

  document.querySelectorAll(".karaoke-toggle").forEach(function (button) {
    button.addEventListener("click", function () { setOpen(!state.open); });
  });
  $("karaoke-close").addEventListener("click", function () { setOpen(false); });
  $("karaoke-refresh").addEventListener("click", function () { refreshMicrophones(true); });
  $("karaoke-start").addEventListener("click", startRecording);
  $("karaoke-stop").addEventListener("click", function () { stopRecording(); });
  $("karaoke-song-gain").addEventListener("input", function () { setGain("karaoke-song-gain", "karaoke-song-value", state.songGain); });
  $("karaoke-mic-gain").addEventListener("input", function () { setGain("karaoke-mic-gain", "karaoke-mic-value", state.micGain); });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", function () { refreshMicrophones(false); });
  window.addEventListener("beforeunload", function () {
    if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
    releaseCapture();
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  });
  window.BiliKaraoke = { close: function () { setOpen(false); }, isRecording: function () { return state.starting || state.recording; } };
})();
