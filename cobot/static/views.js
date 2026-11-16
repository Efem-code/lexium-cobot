// Output tabs over the main view: the 3D scene, the TiM's own scan (like SOPAS ET's monitor), the SEC110 camera
// (simulated from the arm's pose, or the real camera through the bridge) and the SICK devices' own pages.
// Uses app.js / scan.js globals: ctx, B, W, H, F, KEY, proj, line, add, sub, mul, dot, cross, norm, S, FEAT, DEMO,
// TIM, TIM_BODY, TIM_CAM, TIMREAL, timFlange, timCast, drawTimScene, timItems, $.
// Names here start with vw/VW: classic scripts share one global scope.
"use strict";

const VW = {shown: "3d", timZoom: 0, camSrc: "sim", camHost: "", camFps: 0, camFrames: 0, camT: 0};
try { Object.assign(VW, JSON.parse(localStorage.getItem("views") || "{}"), {shown: "3d"}); } catch (_) {}
if (DEMO) VW.camSrc = "sim";   // no bridge in demo mode: only the simulated camera
const vwSave = () => { try { localStorage.setItem("views", JSON.stringify({timZoom: VW.timZoom, camSrc: VW.camSrc, camHost: VW.camHost})); } catch (_) {} };
function vwShown() { return VW.shown; }

function vwShow(v) {
  VW.shown = v;
  for (const b of document.querySelectorAll("#vtabs button")) b.classList.toggle("sel", b.dataset.v === v);
  for (const p of document.querySelectorAll(".vpanel")) p.hidden = p.dataset.v !== v;
  document.body.classList.toggle("vw-3d", v === "3d");
  if (v === "cam") vwCamStart(); else vwCamStop();
  if (v === "dev") vwDevShow();
}
$("vtabs").addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (b) vwShow(b.dataset.v); });

// size a canvas to its box (device pixels) and return its 2D context, or null when it isn't visible
function vwFit(c) {
  const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (r.width < 2 || r.height < 2) return null;
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {g, w: r.width, h: r.height};
}

// ------------------------------------------------------------ TiM scan: the scanner's own view of one scan
// In the scan plane, as the TiM sees it on the mount: 90° (out of its front face) points down at the belt,
// 0° along the flange's +Y. Simulated scans come from the same ray cast the Scan tab records; real ones from the bridge.
function vwTimScan() {
  if (TIM.source === "real") {
    const s = TIMREAL.last;
    if (!s || performance.now() - TIMREAL.lastT > 1500) return null;
    const sg = TIM.flip ? -1 : 1;
    return {real: true, fov: s.dist.length * s.step, start: s.start, step: s.step, freq: s.freq,
            pts: s.dist.map((r, k) => r > 0 ? {a: s.start + s.step * k + 90 - timFace(), r, sg} : null)};
  }
  const f = timFlange(S); if (!f) return null;
  const sc = timCast(f.fl, f.Rf, true), n = sc.hits.length;
  // timCast beam k leaves at th = -fov/2 + fov*k/(n-1) from flange Z towards flange Y: the TiM angle is 90° - th
  return {real: false, fov: TIM.fov, start: 90 - TIM.fov / 2, step: TIM.fov / (n - 1), freq: TIM.rate,
          pts: sc.hits.map((p, k) => p ? {a: 90 + TIM.fov / 2 - TIM.fov * k / (n - 1), r: Math.hypot(...sub(p, sc.o)), sg: 1} : null)};
}
// auto zoom: the beams near the edge of the field run almost level and land metres away, so fit the middle of the
// echoes (2.2 x their median range), not the farthest one
function vwTimFit(pts) {
  if (!pts.length) return Math.max(250, TIM.height * 1.6);
  const r = pts.map(p => p.r).sort((a, b) => a - b);
  return Math.max(250, Math.min(TIM.range, r[r.length >> 1] * 2.2));
}
function vwDrawTim() {
  const fit = vwFit($("cvTim")); if (!fit) return;
  const {g, w, h} = fit, sc = vwTimScan();
  g.fillStyle = "#15161a"; g.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.22;
  const pts = sc ? sc.pts.filter(Boolean) : [];
  const span = VW.timZoom > 0 ? VW.timZoom : vwTimFit(pts);
  const k = Math.min(w / 2, h - cy) * 0.94 / span;
  const XY = (a, r, sg = 1) => [cx + sg * Math.cos(a * Math.PI / 180) * r * k, cy + Math.sin(a * Math.PI / 180) * r * k];
  // range rings and angle spokes
  const ringStep = [50, 100, 250, 500, 1000, 2500].find(s => span / s <= 6) || 5000;
  g.lineWidth = 1; g.font = "11px system-ui, sans-serif"; g.textBaseline = "middle";
  const fov = sc ? sc.fov : TIM.fov, a0 = 90 - fov / 2, a1 = 90 + fov / 2;
  for (let r = ringStep; r <= span * 1.001; r += ringStep) {
    g.strokeStyle = "#2b2e34"; g.beginPath(); g.arc(cx, cy, r * k, a0 * Math.PI / 180, a1 * Math.PI / 180); g.stroke();
    g.fillStyle = "#5c616b"; const [tx, ty] = XY(90, r); g.fillText(r >= 1000 ? `${r / 1000} m` : `${r} mm`, tx + 4, ty - 7);
  }
  for (let a = Math.ceil(a0 / 45) * 45; a <= a1; a += 45) {
    const [tx, ty] = XY(a, span); g.strokeStyle = "#24262b"; g.beginPath(); g.moveTo(cx, cy); g.lineTo(tx, ty); g.stroke();
    g.fillStyle = "#5c616b"; const [lx, ly] = XY(a, span * 1.04); g.fillText(`${a - 90 + timFace()}°`, lx - 10, ly);   // the model's own angles
  }
  // field edges and the blind sector (towards the arm)
  g.strokeStyle = "rgba(232,100,42,.5)"; g.setLineDash([4, 4]);
  for (const a of [a0, a1]) { const [tx, ty] = XY(a, span); g.beginPath(); g.moveTo(cx, cy); g.lineTo(tx, ty); g.stroke(); }
  g.setLineDash([]);
  // the belt (simulated: known height under the scanner)
  if (sc && !sc.real) {
    const yb = cy + TIM.height * k; g.strokeStyle = "rgba(140,150,170,.35)"; g.beginPath(); g.moveTo(0, yb); g.lineTo(w, yb); g.stroke();
    g.fillStyle = "#6b7280"; g.fillText("belt", 8, yb - 8);
  }
  // the points: coloured by range, joined while neighbours are close (like the outline SOPAS draws)
  if (sc) {
    g.lineWidth = 1.5; g.strokeStyle = "rgba(255,90,80,.55)"; g.beginPath();
    let prev = null;
    for (const p of sc.pts) {
      if (!p) { prev = null; continue; }
      const q = XY(p.a, p.r, p.sg);
      if (prev && Math.abs(prev.r - p.r) < 40) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]);
      prev = p;
    }
    g.stroke();
    for (const p of sc.pts) {
      if (!p) continue;
      const [x, y] = XY(p.a, p.r, p.sg); g.fillStyle = `hsl(${Math.max(0, 200 - p.r / span * 200).toFixed(0)},90%,60%)`; g.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }
  // the scanner itself
  g.fillStyle = "#d8b62c"; g.beginPath(); g.arc(cx, cy, 6, 0, 7); g.fill();
  g.fillStyle = "#9aa1ab"; g.fillText("TiM", cx + 10, cy - 10);
  g.fillText("flange +Y →", w - 90, cy); g.fillText(`↓ belt (${timFace()}°)`, cx - 34, h - 12);
  // what it is, and the beam straight down
  const down = sc && sc.pts.reduce((b, p) => (p && Math.abs(p.a - 90) < Math.abs((b && b.a - 90) ?? 1e9) ? p : b), null);
  const n = pts.length, src = !sc ? (TIM.source === "real" ? "Real TiM: no scans (connect it in the Scan tab)" : "Simulated TiM: waiting for the arm's pose")
    : `${sc.real ? "Real TiM" : "Simulated TiM"} · ${fov.toFixed(0)}° field · ${(sc.step).toFixed(2)}° steps · ${n} echoes · ${sc.freq ? sc.freq.toFixed(1) + " Hz" : ""}`;
  $("vTimInfo").innerHTML = `${src}${down ? ` · straight down <b>${down.r.toFixed(0)} mm</b>` : ""}` +
    (TIM.mounted || TIM.source === "real" ? "" : ` · <span style="color:var(--warn)">scanner not on the flange (Scan tab)</span>`);
}
$("cvTim").addEventListener("wheel", e => {
  e.preventDefault();
  const sc = vwTimScan(), pts = sc ? sc.pts.filter(Boolean) : [];
  const cur = VW.timZoom > 0 ? VW.timZoom : vwTimFit(pts);
  VW.timZoom = Math.max(100, Math.min(TIM.range, cur * (e.deltaY > 0 ? 1.15 : 1 / 1.15))); vwSave();
}, {passive: false});
$("cvTim").addEventListener("dblclick", () => { VW.timZoom = 0; vwSave(); });

// ------------------------------------------------------------ SEC110: where it is and what it sees
// Pose from the flange: back face centre at (TIM_CAM.x, 0, TIM_CAM.z), tilted about flange Y; lens 33.6 mm out.
function vwCamPose() {
  const f = timFlange(S); if (!f) return null;
  const {fl, Rf} = f, ex = [Rf[0][0], Rf[1][0], Rf[2][0]], ey = [Rf[0][1], Rf[1][1], Rf[2][1]], ez = [Rf[0][2], Rf[1][2], Rf[2][2]];
  const t = -TIM_CAM.tilt * Math.PI / 180, cx = add(mul(ex, Math.cos(t)), mul(ez, -Math.sin(t))), cz = add(mul(ex, Math.sin(t)), mul(ez, Math.cos(t)));
  const back = add(fl, add(mul(ex, TIM_CAM.x), mul(ez, TIM_CAM.z)));
  const eye = add(back, mul(cz, TIM_CAM.lens)), r = ey, u = cross(r, cz);   // image right = flange +Y, up = the connector end
  return {eye, f: cz, r, u, cx};
}
// Draw the scene through the camera: swap app.js's drawing globals, reuse drawTimScene, swap back.
function vwDrawSimCam() {
  const fit = vwFit($("cvCam")); if (!fit) return;
  let {g, w, h} = fit;
  // keep the camera's 16:9 picture, letterboxed
  const ar = Math.tan(TIM_CAM.hfov / 2 * Math.PI / 180) / Math.tan(TIM_CAM.vfov / 2 * Math.PI / 180);
  const iw = Math.min(w, h * ar), ih = iw / ar, ox = (w - iw) / 2, oy = (h - ih) / 2;
  g.fillStyle = "#0d0e10"; g.fillRect(0, 0, w, h);
  const pose = vwCamPose();
  if (!pose) { g.fillStyle = "#6b7280"; g.font = "13px system-ui"; g.fillText("No arm pose yet", ox + 16, oy + 24); return; }
  const save = {ctx, B, W, H, F, KEY};
  try {
    g.save(); g.beginPath(); g.rect(ox, oy, iw, ih); g.clip(); g.translate(ox, oy);
    ctx = g; W = iw; H = ih; F = (iw / 2) / Math.tan(TIM_CAM.hfov / 2 * Math.PI / 180);
    B = {eye: pose.eye, f: pose.f, r: pose.r, u: pose.u}; KEY = norm(add(mul(pose.u, .5), mul(pose.f, -.8)));
    // the table, lit from the camera's side, with a 50 mm grid for scale
    const zt = -viewDrop;
    g.fillStyle = "#2d3036"; g.fillRect(0, 0, iw, ih);
    const c = pose.eye, R = 900;
    for (let v = -R; v <= R; v += 50) {
      const xs = Math.round((c[0] + v) / 50) * 50, ys = Math.round((c[1] + v) / 50) * 50, col = "rgba(255,255,255,.05)";
      line([xs, c[1] - R, zt], [xs, c[1] + R, zt], col, 1); line([c[0] - R, ys, zt], [c[0] + R, ys, zt], col, 1);
    }
    const show = TIM.show; TIM.show = {items: true, cloud: false, belt: false};
    const src = TIM.source; TIM.source = "sim";   // the camera always sees the simulated items here
    try { drawTimScene(); } finally { TIM.show = show; TIM.source = src; }
    // the TiM's laser line where it lands (the real SEC110 may not see the TiM's infrared light at all)
    if (TIM.mounted && $("vCamLaser").checked) {
      const fl = timFlange(S), sc = fl && timCast(fl.fl, fl.Rf, false);
      if (sc) {
        g.strokeStyle = "rgba(255,60,60,.9)"; g.lineWidth = 2; g.beginPath(); let on = false;
        for (const p of sc.hits) { const P = p && proj(p); if (!P) { on = false; continue; } on ? g.lineTo(P[0], P[1]) : g.moveTo(P[0], P[1]); on = true; }
        g.stroke();
      }
    }
  } finally {
    g.restore(); ({ctx, B, W, H, F, KEY} = save);
  }
  // frame and a light sensor-noise look, so it reads as a camera picture
  g.strokeStyle = "#3a3d44"; g.strokeRect(ox + .5, oy + .5, iw - 1, ih - 1);
  g.fillStyle = "rgba(255,255,255,.75)"; g.font = "11px ui-monospace, monospace";
  g.fillText(`SIM SEC110  ${TIM_CAM.hfov}°×${TIM_CAM.vfov}°  ${new Date().toLocaleTimeString()}`, ox + 8, oy + 16);
  const d = pose.eye[2] - TIM.beltZ;
  $("vCamInfo").innerHTML = `Simulated SEC110 on the mount · lens <b>${d.toFixed(0)} mm</b> above the belt` +
    (d < 300 ? ` · <span style="color:var(--warn)">closer than its 0.3 m working distance: the real picture would be blurred</span>` : "");
}

// ------------------------------------------------------------ the loop for the non-3D tabs
function vwLoop() {
  requestAnimationFrame(vwLoop);
  try {
    if (VW.shown === "tim") vwDrawTim();
    else if (VW.shown === "cam" && VW.camSrc === "sim") vwDrawSimCam();
  } catch (e) { if (!vwLoop.err) { vwLoop.err = 1; console.error(e); } }
}
requestAnimationFrame(vwLoop);

// ------------------------------------------------------------ the real SEC110, through the bridge (cobot/sec.py)
VW.camState = null;
function vwCamPanel() {
  const p = document.querySelector('.vpanel[data-v="cam"]');
  p.classList.toggle("cam-sim", VW.camSrc !== "real"); p.classList.toggle("cam-real", VW.camSrc === "real");
  for (const r of document.querySelectorAll('input[name="vCamSrc"]')) { r.checked = r.value === VW.camSrc; r.disabled = r.value === "real" && DEMO; }
  if (document.activeElement !== $("vCamHost")) $("vCamHost").value = VW.camHost || "";
  $("vCamEvery").value = VW.camEvery || 100; $("vCamPass").checked = !!VW.camPassOn; $("vCamMode").value = VW.camMode || "jpeg";
}
async function vwCamPoll() {
  if (VW.shown !== "cam" || VW.camSrc !== "real" || DEMO) return;
  try { VW.camState = await (await fetch("api/cam/status")).json(); } catch (_) { VW.camState = null; }
  const s = VW.camState;
  $("vCamInfo").innerHTML = !s ? "Bridge not reachable" : !s.host ? "Real SEC110: not connected. Its address: DHCP, or 192.168.136.100 if no DHCP server answers."
    : `Real SEC110 at <b>${s.host}</b> · ${s.mode === "rtsp" ? "video (RTSP)" : "pictures (HTTP)"} · ` +
      (s.connected ? `<b>${s.rate}</b> pictures/s · ${s.frames} so far` : `<span style="color:var(--warn)">${s.error || "connecting…"}</span>`) +
      (s.info && s.info.firmware ? ` · firmware ${JSON.stringify(s.info.firmware).replace(/[{}"]/g, "")}` : "");
  // (re)open the live picture when the camera is up and the <img> isn't showing it
  const img = $("imgCam");
  if (s && s.connected && !img.dataset.live) { img.dataset.live = 1; img.src = "api/cam/live?" + Date.now(); }
  if ((!s || !s.connected) && img.dataset.live) { delete img.dataset.live; img.removeAttribute("src"); }
}
setInterval(vwCamPoll, 1000);
function vwCamStart() { vwCamPanel(); vwCamPoll(); }
function vwCamStop() { const img = $("imgCam"); delete img.dataset.live; img.removeAttribute("src"); }
$("imgCam").onerror = () => { delete $("imgCam").dataset.live; };
for (const r of document.querySelectorAll('input[name="vCamSrc"]')) r.onchange = () => { VW.camSrc = r.value; vwSave(); vwCamStop(); vwCamStart(); };
$("vCamConn").onclick = async () => {
  VW.camHost = $("vCamHost").value.trim(); VW.camMode = $("vCamMode").value; vwSave();
  if (!VW.camHost) { toast("Enter the camera's IP address"); return; }
  const r = await api("/api/cam/connect", {host: VW.camHost, mode: VW.camMode, fps: 5, user: $("vCamUser").value.trim() || "Service", password: $("vCamPass").value});
  if (!r.errorCode) vwCamPoll();
};
$("vCamDisc").onclick = async () => { await api("/api/cam/disconnect", {}); vwCamStop(); vwCamPoll(); };
$("vCamMode").onchange = e => { VW.camMode = e.target.value; vwSave(); };
$("vCamPass").onchange = e => { VW.camPassOn = e.target.checked; vwSave(); };
$("vCamEvery").onchange = e => { VW.camEvery = Math.max(10, +e.target.value || 100); vwSave(); vwCamPanel(); };
function vwPoseMeta() { return {tcp: S.tcp, joints: S.joints, travel_mm: +timTravel.toFixed(1), scan_volume_cm3: +(timVol / 1000).toFixed(1)}; }
$("vCamSnap").onclick = async () => {
  if (VW.camSrc === "real") {
    const r = await api("/api/cam/save", {name: "manual", meta: vwPoseMeta()});
    if (!r.errorCode) toast("Saved on this PC: " + r.file);
    return;
  }
  const a = document.createElement("a");
  a.href = $("cvCam").toDataURL("image/png"); a.download = `sim-sec110-${new Date().toISOString().replace(/[:.]/g, "-")}.png`; a.click();
};
// pictures during a pass: every N mm of scanner travel while the Scan tab records (real camera only)
const VWPASS = {rec: false, next: 0, n: 0, id: ""};
setInterval(async () => {
  const rec = typeof TIMJOB !== "undefined" && TIMJOB.recording;
  if (rec && !VWPASS.rec) Object.assign(VWPASS, {next: 0, n: 0, id: (d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${d.toTimeString().slice(0, 8).replace(/:/g, "")}`)(new Date())});
  VWPASS.rec = rec;
  if (!rec || !VW.camPassOn || VW.camSrc !== "real" || DEMO || !(VW.camState && VW.camState.connected)) return;
  if (timTravel < VWPASS.next) return;
  VWPASS.next = timTravel + (VW.camEvery || 100); VWPASS.n++;
  const r = await api("/api/cam/save", {name: `pass${VWPASS.id}-${String(VWPASS.n).padStart(3, "0")}`, meta: {...vwPoseMeta(), pass: VWPASS.id}});
  if (r.errorCode) VW.camPassOn = false;   // api() already showed the error: stop trying for this pass
}, 200);

// ------------------------------------------------------------ the SICK devices' own pages and status
async function vwDevShow() {
  let cam = null;
  if (!DEMO) try { cam = await (await fetch("api/cam/status")).json(); } catch (_) {}
  const t = TIMREAL.state, m = TIM_MODELS[TIM.model] || TIM_MODELS.tim5xx, host = (cam && cam.host) || VW.camHost;
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
  $("vDev").innerHTML = `
  <div class="devcard"><h3>SICK ${esc(m.name)} (2D LiDAR)</h3>
    ${TIM.source === "real" ? (t ? `At <b>${esc(t.host)}:${esc(t.port)}</b> · ${t.connected ? `connected, CoLa ${esc(t.proto)}, <b>${t.rate}</b> scans/s` : `<span style="color:var(--warn)">${esc(t.error || "not connected")}</span>`}`
      : "Real TiM chosen, no status yet (Scan tab → Connect).") : "Simulated in this page (Scan tab → Scans from → Real TiM for the real one)."}<br>
    The TiM has no web page of its own: SICK configures it with <b>SOPAS ET</b> (Windows), over Ethernet on TCP port 2111.
    ${TIM.model === "tim240" ? "The TiM240 takes <b>one</b> TCP connection: press Disconnect in the Scan tab before opening it in SOPAS ET." : "Disconnect it here first if SOPAS ET can't reach it."}
    The <b>TiM scan</b> tab shows its scans the way SOPAS ET's monitor does.</div>
  <div class="devcard"><h3>SICK SEC110 (sensingCam)</h3>
    ${cam && cam.host ? `At <b>${esc(cam.host)}</b> · ${cam.connected ? "streaming to this PC" : esc(cam.error || "not connected")}${cam.info && cam.info.serial ? ` · serial ${esc(JSON.stringify(cam.info.serial).replace(/[{}"]/g, ""))}` : ""}<br>` : "Not connected (Camera tab → Real SEC110).<br>"}
    Its own web page does the set-up: users and passwords (change the factory ones), network, video and RTSP, snapshots,
    event recording, FTP upload and time sync. For the Camera tab, switch on <i>Diagnostics → Cybersecurity → authentication-free API</i>
    there (or give the Service password when connecting) and, for video, RTSP on stream 0.
    ${host ? `<div style="margin-top:8px"><a href="http://${esc(host)}/" target="_blank" rel="noopener"><button>Open the SEC110's web page</button></a>
      <button id="vDevFrame">Show it here</button></div><div id="vDevFrameBox"></div>
      <div class="vnote">The page loads in your browser, so this device must reach ${esc(host)} itself (the PC running the app reaches it for the Camera tab).</div>` : ""}
  </div>`;
  const b = $("vDevFrame");
  if (b) b.onclick = () => { $("vDevFrameBox").innerHTML = `<iframe src="http://${esc(host)}/" referrerpolicy="no-referrer"></iframe>`; };
}
vwCamPanel();
