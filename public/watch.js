(async function () {
  const video = document.getElementById("video");
  const stage = document.getElementById("stage");
  const wm = document.getElementById("wm");
  const wm2 = document.getElementById("wm2");
  const err = document.getElementById("err");

  const me = await fetch("/api/me").then((r) => (r.ok ? r.json() : null));
  if (!me) return location.replace("/");

  document.getElementById("hello").textContent = "שלום " + me.name;
  document.getElementById("exp").textContent =
    "הגישה בתוקף עד " + new Date(me.expires).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });

  // ----- watermark: viewer name + code, moves around so it can't be cropped out
  const label = me.name + " · " + me.code;
  wm.textContent = label;
  wm2.textContent = label;
  function moveWatermark() {
    const w = stage.clientWidth, h = stage.clientHeight;
    const x = Math.random() * Math.max(0, w - wm.offsetWidth - 20) + 10;
    const y = Math.random() * Math.max(0, h - wm.offsetHeight - 60) + 10;
    wm.style.left = x + "px";
    wm.style.top = y + "px";
  }
  wm2.style.right = "12px";
  wm2.style.bottom = "56px";
  moveWatermark();
  setInterval(moveWatermark, 7000);

  // ----- player
  const src = "/v/" + encodeURIComponent(me.video) + "/index.m3u8";
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ xhrSetup: (xhr) => (xhr.withCredentials = true) });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.response && (data.response.code === 401 || data.response.code === 403)) {
        hls.destroy();
        showError("הגישה לסרטון הסתיימה או בוטלה.");
        return;
      }
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else showError("שגיאה בניגון הסרטון.");
      }
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = src; // Safari / iPhone native HLS
  } else {
    showError("הדפדפן לא תומך בניגון. נסה Chrome, Edge, Firefox או Safari מעודכן.");
  }

  // ----- fullscreen on the wrapper (so the watermark stays visible)
  const fsBtn = document.getElementById("fs");
  fsBtn.addEventListener("click", async () => {
    if (document.fullscreenElement || stage.classList.contains("pseudo-fs")) {
      if (document.fullscreenElement) await document.exitFullscreen();
      stage.classList.remove("pseudo-fs");
    } else if (stage.requestFullscreen) {
      try { await stage.requestFullscreen(); } catch { stage.classList.add("pseudo-fs"); }
    } else {
      stage.classList.add("pseudo-fs"); // iPhone: no Fullscreen API for elements
    }
    setTimeout(moveWatermark, 300);
  });
  video.addEventListener("dblclick", (e) => { e.preventDefault(); fsBtn.click(); });

  // ----- small deterrents (not real protection — see README)
  stage.addEventListener("contextmenu", (e) => e.preventDefault());
  video.addEventListener("enterpictureinpicture", () => document.exitPictureInPicture?.());

  // Re-check access every 5 minutes; stop playback if the code was revoked/expired.
  setInterval(async () => {
    const r = await fetch("/api/me");
    if (r.status === 401) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      showError("הגישה לסרטון הסתיימה או בוטלה.");
    }
  }, 5 * 60 * 1000);

  document.getElementById("logout").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    location.replace("/");
  });

  function showError(msg) {
    err.textContent = msg;
  }
})();
