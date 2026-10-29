// Lexium Cobot controller UI. Runs in two modes:
//  * bridge: served by the Python app (run.py), talks to /api/* over HTTP
//  * demo:   static hosting (GitHub Pages / ?demo), simulator runs in this page (sim.js)
"use strict";
const $ = id => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has("demo") || location.hostname.endsWith("github.io") || location.protocol === "file:";
if (DEMO) document.body.classList.add("demo");

let S = {};                 // latest status
let profiles = {}, limits = [], HOME = [];
let mode = "sim", frame = "base";
let ghost = null;           // {points, joints} preview
let target = null;          // {pose, ok}
let waypoints = [];
let sliderDirty = false;
try { waypoints = JSON.parse(localStorage.getItem("waypoints") || "[]"); } catch (_) {}

// ------------------------------------------------------------ transport
const HttpTransport = {
  async call(path, body) {
    const r = await fetch(path, body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    if (r.status === 401) { showPin(); return {errorCode: "401", errorMsg: "PIN required"}; }
    return r.json();
  },
  subscribe(cb) {
    const open = () => {
      const es = new EventSource("api/stream");
      es.onmessage = ev => cb(JSON.parse(ev.data));
      es.onerror = () => { cb({connected: false, bridge_down: true}); es.close(); setTimeout(open, 2000); };
    };
    open();
  },
};
const T = DEMO ? new CobotSim.LocalTransport() : HttpTransport;

async function api(path, body) {
  let j;
  try { j = await T.call(DEMO ? path : path.replace(/^\//, ""), body); }
  catch (e) { toast("Bridge not reachable: " + e.message); return {errorCode: "net", errorMsg: e.message}; }
  if (j && j.errorCode && j.errorCode !== "0" && j.errorCode !== 0 && j.errorCode !== "401") toast(j.errorMsg || ("error " + j.errorCode));
  return j;
}
const cmd = (name, extra = {}) => api("/api/cmd", Object.assign({cmdName: name}, extra));
function toast(msg) { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = "none", 3500); }

// ------------------------------------------------------------ PIN (bridge only)
function showPin() { $("pin").classList.add("show"); setTimeout(() => $("pinIn").focus(), 50); }
$("pinGo").onclick = async () => {
  const r = await fetch("api/login", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({pin: $("pinIn").value})}).then(r => r.json()).catch(() => ({}));
  if (r.ok) { $("pin").classList.remove("show"); location.reload(); }
  else $("pinErr").textContent = r.error || "Wrong PIN";
};
$("pinIn").addEventListener("keydown", e => { if (e.key === "Enter") $("pinGo").onclick(); });

// ------------------------------------------------------------ tabs (phones)
$("tabs").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("sel", x === b));
  document.querySelectorAll(".card[data-tab]").forEach(c => c.classList.toggle("show", c.dataset.tab === b.dataset.tab));
});

// ------------------------------------------------------------ build UI
const JN = ["J1", "J2", "J3", "J4", "J5", "J6"], CN = ["X", "Y", "Z", "RX", "RY", "RZ"];
function holdButton(btn, start) {
  // Hold-to-run: jog while pressed, keepalive every 100 ms, stop on release.
  btn.classList.add("hold");
  let timer = null, active = false;
  const stop = () => { if (!active) return; active = false; btn.classList.remove("held"); clearInterval(timer); api("/api/jog/stop", {}); };
  btn.addEventListener("pointerdown", async e => {
    e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    active = true; btn.classList.add("held");
    if (navigator.vibrate) navigator.vibrate(15);
    const r = await start();
    if (!active) { api("/api/jog/stop", {}); return; }
    if (r && r.errorCode && r.errorCode !== "0") { stop(); return; }
    timer = setInterval(() => api("/api/jog/keepalive", {}), 100);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(ev => btn.addEventListener(ev, stop));
  btn.addEventListener("contextmenu", e => e.preventDefault());
  window.addEventListener("blur", stop);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
}
function buildJog() {
  const J = $("joints");
  JN.forEach((n, i) => {
    const d = document.createElement("div"); d.className = "jog";
    d.innerHTML = `<span class="n">${n}</span><span class="v mono" id="jv${i}">—</span><button>−</button><button>+</button><input type="range" id="js${i}" step="0.5">`;
    J.appendChild(d);
    const [bm, bp] = d.querySelectorAll("button");
    holdButton(bm, () => api("/api/jog", {coord: "joint", axis: i, dir: -1, speed: +$("jspd").value}));
    holdButton(bp, () => api("/api/jog", {coord: "joint", axis: i, dir: +1, speed: +$("jspd").value}));
    d.querySelector("input").addEventListener("input", () => { sliderDirty = true; previewJoints(sliderJoints()); });
  });
  const C = $("cart");
  CN.forEach((n, i) => {
    const d = document.createElement("div"); d.className = "jog";
    d.innerHTML = `<span class="n">${n}</span><span class="v mono" id="cv${i}">—</span><button>−</button><button>+</button>`;
    C.appendChild(d);
    const [bm, bp] = d.querySelectorAll("button");
    const sp = () => i < 3 ? +$("cspd").value : +$("rspd").value;
    holdButton(bm, () => api("/api/jog", {coord: frame, axis: i, dir: -1, speed: sp()}));
    holdButton(bp, () => api("/api/jog", {coord: frame, axis: i, dir: +1, speed: sp()}));
  });
  for (let k = 0; k < 16; k++) {
    const o = document.createElement("div"); o.textContent = k; o.id = "do" + k; $("dout").appendChild(o);
    o.onclick = () => cmd("set_digital_output", {type: 0, index: k, value: (S.dout && S.dout[k]) ? 0 : 1});
    const n = document.createElement("div"); n.textContent = k; n.id = "di" + k; $("din").appendChild(n);
    n.onclick = () => { if (S.mode !== "real") cmd("sim_set_din", {index: k, value: (S.din && S.din[k]) ? 0 : 1}); };
  }
}
const sliderJoints = () => JN.map((_, i) => +$("js" + i).value);
function syncSliders() { if (!S.joints) return; S.joints.forEach((v, i) => $("js" + i).value = v); sliderDirty = false; ghost = null; }
async function previewJoints(q) { const r = await api("/api/fk", {joints: q}); if (r.points) ghost = {points: r.points, joints: q}; }
const jspeed = () => +$("jspd").value * 2;

// ------------------------------------------------------------ buttons
function seg(a, b, cb) { a.onclick = () => { a.classList.add("sel"); b.classList.remove("sel"); cb(0); }; b.onclick = () => { b.classList.add("sel"); a.classList.remove("sel"); cb(1); }; }
seg($("mSim"), $("mReal"), v => {
  mode = v ? "real" : "sim"; $("realArm").style.display = v ? "block" : "none";
  if (!v) $("host").value = "127.0.0.1"; else if ($("host").value === "127.0.0.1") $("host").value = "10.5.5.100";
});
seg($("fBase"), $("fTool"), v => frame = v ? "tool" : "base");
$("btnConnect").onclick = async () => {
  const [c, s] = $("pcs").value.split("/").map(Number);
  await api("/api/connect", {host: $("host").value.trim(), mode, modbus_port: +$("pmb").value, cmd_port: c || 10001, status_port: s || 10000, model: $("model").value});
  setTimeout(syncSliders, 400);
};
$("btnDisconnect").onclick = () => api("/api/disconnect", {});
// Demo -> bridge. A secure (https) page can't fetch from a plain-http LAN address,
// so we navigate to the bridge, which serves the same app.
try { $("bridgeAddr").value = localStorage.getItem("bridgeAddr") || ""; } catch (_) {}
$("goLive").onclick = () => {
  let a = $("bridgeAddr").value.trim(); if (!a) { toast("Enter the bridge address shown on the PC"); return; }
  if (!/^https?:\/\//.test(a)) a = "http://" + a;
  if (!/:\d+/.test(a.replace(/^https?:\/\//, ""))) a += ":8765";
  try { localStorage.setItem("bridgeAddr", $("bridgeAddr").value.trim()); } catch (_) {}
  location.href = a + "/";
};
$("arm").onchange = e => {
  if (e.target.checked && !confirm("Arm motion on the REAL cobot?\n\nThe arm will move when you jog or send moves. Make sure the area is clear and the E-stop is in reach.")) { e.target.checked = false; return; }
  api("/api/arm", {armed: e.target.checked});
};
$("model").onchange = () => api("/api/model", {model: $("model").value});
$("modelDemo").onchange = () => api("/api/model", {model: $("modelDemo").value});
$("btnStop").onclick = () => api("/api/stop", {});
$("bPower").onclick = () => cmd("power_on");
$("bPowerOff").onclick = () => cmd("power_off");
$("bEnable").onclick = () => cmd("enable_robot");
$("bDisable").onclick = () => cmd("disable_robot");
$("bClear").onclick = () => cmd("clear_error");
$("bHome").onclick = () => {
  if (S.mode === "real" && !confirm(`Move the REAL arm to the home pose?

All joints move at once, at ${S.speed_override ?? "?"}% speed. Make sure the path is clear.`)) return;
  cmd("joint_move", {relFlag: 0, jointPosition: HOME, speed: jspeed(), accel: 100});
};
$("bEstop").onclick = () => cmd("sim_estop", {on: !S.estop});
$("bColl").onclick = () => cmd("sim_protective_stop");
$("bResetSim").onclick = () => cmd("clear_error");
$("bSrc").onclick = () => cmd("sim_control_source", {source: S.control_source === "remote" ? "local" : "remote"});
$("bSliders").onclick = () => { cmd("joint_move", {relFlag: 0, jointPosition: sliderJoints(), speed: jspeed(), accel: 100}); sliderDirty = false; ghost = null; };
$("bSync").onclick = syncSliders;
for (const [sl, lab] of [["speed", "speedV"], ["speed2", "speedV2"]]) {
  $(sl).oninput = e => { $(lab).textContent = e.target.value + "%"; };
  $(sl).onchange = e => cmd("set_rapidrate", {rapid_rate: e.target.value / 100});
}
$("bTeach").onclick = () => { if (!S.joints) return; waypoints.push({joints: [...S.joints], tcp: [...S.tcp]}); drawWps(); };
$("bPlay").onclick = playWps;
$("tCancel").onclick = () => { target = null; ghost = null; $("targetBar").classList.remove("show"); };
$("tLin").onclick = async () => { if (!target) return; await cmd("moveL", {relFlag: 0, cartPosition: target.pose, speed: +$("cspd").value * 2, accel: 500}); $("tCancel").onclick(); };
$("tJnt").onclick = async () => { if (!target || !ghost) return; await cmd("joint_move", {relFlag: 0, jointPosition: ghost.joints, speed: jspeed(), accel: 100}); $("tCancel").onclick(); };

function drawWps() {
  try { localStorage.setItem("waypoints", JSON.stringify(waypoints)); } catch (_) {}
  const W = $("wps"); if (!waypoints.length) { W.textContent = "No waypoints yet."; return; }
  W.innerHTML = ""; waypoints.forEach((w, i) => {
    const d = document.createElement("div"); d.className = "wp";
    d.innerHTML = `<span class="mono">P${i + 1} ${w.tcp.slice(0, 3).map(v => v.toFixed(0)).join(", ")}</span><span class="row"><button>Go</button><button>✕</button></span>`;
    const [g, x] = d.querySelectorAll("button");
    g.onclick = () => cmd("joint_move", {relFlag: 0, jointPosition: w.joints, speed: jspeed(), accel: 100});
    x.onclick = () => { waypoints.splice(i, 1); drawWps(); };
    W.appendChild(d);
  });
}
let playing = false;
try { $("loop").checked = localStorage.getItem("loop") === "1"; $("dwell").value = localStorage.getItem("dwell") || "0"; } catch (_) {}
$("loop").onchange = e => { try { localStorage.setItem("loop", e.target.checked ? "1" : "0"); } catch (_) {} };
$("dwell").onchange = e => { try { localStorage.setItem("dwell", e.target.value); } catch (_) {} };
const sleep = ms => new Promise(res => setTimeout(res, ms));
async function playWps() {
  if (playing) { playing = false; $("bPlay").textContent = "Play"; api("/api/stop", {}); return; }
  if (!waypoints.length) return;
  playing = true; $("bPlay").textContent = "Stop play";
  let cycle = 0;
  // Loop is re-read every cycle, so unticking it finishes the current cycle and stops.
  do {
    cycle++; $("cycles").textContent = "cycle " + cycle;
    for (const w of waypoints) {
      if (!playing) break;
      const r = await cmd("joint_move", {relFlag: 0, jointPosition: w.joints, speed: jspeed(), accel: 100});
      if (r.errorCode !== "0") { playing = false; break; }
      await sleep(250);
      while (playing && S.inpos === false) await sleep(50);
      // stop the loop on any fault (e-stop, protective stop, disabled)
      if (S.estop || S.protective_stop || S.enabled === false) { playing = false; toast("Play stopped: robot not ready"); break; }
      const dwell = Math.max(0, +$("dwell").value || 0);
      if (playing && dwell) await sleep(dwell * 1000);
    }
  } while (playing && $("loop").checked);
  playing = false; $("bPlay").textContent = "Play";
}

// ------------------------------------------------------------ status rendering
let shownMode = null;
function pill(id, cls, txt) { const p = $(id); p.className = "pill " + cls; if (txt) p.textContent = txt; }
function render() {
  const P = S.ports || {};
  pill("pMode", S.connected ? "ok" : "bad", S.mode === "demo" ? "DEMO" : S.connected ? (S.mode === "sim" ? "SIMULATOR" : "REAL " + S.host) : (S.bridge_down ? "bridge offline" : "offline"));
  // Modbus is optional on the real cobot when the (TLS) status stream is up
  pill("pModbus", S.modbus_ok ? "ok" : (S.connected && !S.stream_ok ? "bad" : ""), "Modbus " + (P.modbus || 502));
  pill("pCmd", S.cmd_ok ? "ok" : "", "Cmd " + (P.cmd || 10001) + (S.tls ? " TLS" : ""));
  pill("pStream", S.stream_ok ? "ok" : "", "Status " + (P.status || 10000) + (S.tls ? " TLS" : ""));
  pill("pArm", S.motion_armed ? "ok" : "warn", S.motion_armed ? "motion enabled" : "read-only");
  $("connErr").textContent = S.last_error || "";
  $("simTools").style.display = S.mode === "real" ? "none" : "block";
  // follow the bridge when it connected itself (e.g. ipad.py auto-connects to the real cobot)
  if ((S.mode === "real" || S.mode === "sim") && S.mode !== shownMode) {
    shownMode = S.mode; $(S.mode === "real" ? "mReal" : "mSim").onclick();
    if (S.host) $("host").value = S.host;
  }
  if (document.activeElement !== $("arm")) $("arm").checked = !!S.motion_armed;
  // real cobot: the bridge enforces the speed limit, so show its value
  if (S.mode === "real" && S.speed_override != null)
    for (const [sl, lab] of [["speed", "speedV"], ["speed2", "speedV2"]])
      if (document.activeElement !== $(sl)) { $(sl).value = S.speed_override; $(lab).textContent = S.speed_override + "%"; }
  const L =[["Power", S.powered, "on"], ["Enabled", S.enabled, "on"], ["E-stop", S.estop, "red"], ["Prot. stop", S.protective_stop, "red"],
             ["Soft limit", S.on_soft_limit, "amber"], ["In position", S.inpos, "on"], ["Jogging", S.jogging, "amber"]];
  // the real controller doesn't report a control source; only the simulator models it
  if (S.mode !== "real") L.push(["Remote ctl", S.control_source === "remote", "on"]);
  $("lights").innerHTML = L.map(([n, v, c]) => `<div class="light"><span class="dot ${v ? c : ""}"></span>${n}</div>`).join("") +
    `<div class="light" style="grid-column:1/-1">Mode: <b style="color:var(--text)">${S.motion_mode || "—"}</b>${S.errcode ? ` · <b style="color:var(--bad)">Err ${S.errcode}${S.errmsg ? ": " + S.errmsg : ""}</b>` : ""}</div>`;
  $("bEstop").textContent = S.estop ? "Release E-stop" : "E-stop";
  $("bSrc").textContent = "Control: " + (S.control_source === "remote" ? "Remote" : "Local");
  if (S.joints) {
    S.joints.forEach((v, i) => { $("jv" + i).textContent = v.toFixed(2) + "°"; if (!sliderDirty && document.activeElement !== $("js" + i)) $("js" + i).value = v; });
    S.tcp.forEach((v, i) => $("cv" + i).textContent = v.toFixed(i < 3 ? 1 : 2) + (i < 3 ? "" : "°"));
    $("live").innerHTML = "<tr><th></th><th>°/s</th><th>A</th><th>°C</th><th>V</th></tr>" + JN.map((n, i) =>
      `<tr><td>${n}</td><td>${S.joint_speed[i].toFixed(1)}</td><td>${S.joint_current[i].toFixed(2)}</td><td>${S.joint_temp[i]}</td><td>${S.joint_voltage[i]}</td></tr>`).join("");
    $("cab").textContent = `${S.cab_temp.toFixed(1)} °C · ${S.cab_power.toFixed(0)} W · speed ${S.speed_ratio.toFixed(0)}%`;
    for (let k = 0; k < 16; k++) { $("do" + k).classList.toggle("on", !!(S.dout && S.dout[k])); $("di" + k).classList.toggle("on", !!(S.din && S.din[k])); }
    for (const [sl, lab] of [["speed", "speedV"], ["speed2", "speedV2"]])
      if (document.activeElement !== $(sl)) { $(sl).value = Math.round(S.speed_ratio); $(lab).textContent = Math.round(S.speed_ratio) + "%"; }
  }
  if (S.log) $("log").innerHTML = S.log.slice().reverse().map(l => `<div>${String(l).replace(/</g, "&lt;")}</div>`).join("");
  for (const sel of ["model", "modelDemo"])
    if (S.model && $(sel).value !== S.model && document.activeElement !== $(sel)) $(sel).value = S.model;
  if (S.model && S.model !== fittedModel && profiles[S.model]) fitCamera(profiles[S.model].reach);
}

// ------------------------------------------------------------ 3D view (canvas, no libraries)
const cv = $("cv"), ctx = cv.getContext("2d");
const cam = {yaw: -2.2, pitch: 0.38, dist: 1750, tx: -220, ty: -60, tz: 330};
let fittedModel = null;
function fitCamera(reach) {
  fittedModel = S.model;
  const narrow = cv.clientWidth < 500 ? 1.3 : (cv.clientWidth < 1000 ? 0.7 : 1);
  Object.assign(cam, {dist: reach * 2.15 * narrow, tx: -reach * 0.27, ty: -reach * 0.07, tz: reach * 0.4});
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => mul(a, 1 / Math.hypot(...a));
function camBasis() {
  const cp = Math.cos(cam.pitch), eye = [cam.tx + cam.dist * cp * Math.cos(cam.yaw), cam.ty + cam.dist * cp * Math.sin(cam.yaw), cam.tz + cam.dist * Math.sin(cam.pitch)];
  const f = norm(sub([cam.tx, cam.ty, cam.tz], eye)), r = norm(cross(f, [0, 0, 1])), u = cross(r, f);
  return {eye, f, r, u};
}
let B, W, H, F;
function proj(p) { const d = sub(p, B.eye), z = dot(d, B.f); if (z < 10) return null; return [W / 2 + dot(d, B.r) * F / z, H / 2 - dot(d, B.u) * F / z, z]; }
const rayDir = (sx, sy) => norm(add(B.f, add(mul(B.r, (sx - W / 2) / F), mul(B.u, (H / 2 - sy) / F))));
function rayPlaneZ(sx, sy, z0) { const dir = rayDir(sx, sy); if (Math.abs(dir[2]) < 1e-6) return null; const t = (z0 - B.eye[2]) / dir[2]; return t > 0 ? add(B.eye, mul(dir, t)) : null; }
function rayVertical(sx, sy, p) { const n = norm([B.f[0], B.f[1], 0]), dir = rayDir(sx, sy), den = dot(dir, n); if (Math.abs(den) < 1e-6) return null; return add(B.eye, mul(dir, dot(sub(p, B.eye), n) / den)); }
function rpyR(rx, ry, rz) {
  rx *= Math.PI / 180; ry *= Math.PI / 180; rz *= Math.PI / 180;
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [[cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx], [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx], [-sy, cy * sx, cy * cx]];
}
function line(a, b, color, w) { const A = proj(a), Bp = proj(b); if (!A || !Bp) return; ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(Bp[0], Bp[1]); ctx.stroke(); }
// Arm colours, after the real Lexium Cobot: silver links, green joint housings, silver end caps.
const PAINT = {
  grey: ["#eef1f4", "#b9c0c8", "#7d8893"], green: ["#8fe89c", "#3dcd58", "#1f8a36"], cap: ["#ffffff", "#d9dee3", "#9aa4ae"],
  ghost: ["#a9cfff", "#5d9bf0", "#2f6bc0"],
};
// One shaded cylinder from p0 to p1. capAt: 0 or 1 puts a silver end cap on that end.
function cyl(p0, p1, r, paint, capAt) {
  const A = proj(p0), Bq = proj(p1); if (!A || !Bq) return;
  const ax = norm(sub(p1, p0)), ang = Math.atan2(Bq[1] - A[1], Bq[0] - A[0]);
  const ends = [[p0, A], [p1, Bq]].map(([p, P]) => {
    const R = r * F / P[2], k = Math.abs(dot(ax, norm(sub(p, B.eye))));
    return {P, R, rMinor: Math.max(R * k, 0.5)};
  });
  const nx = -Math.sin(ang), ny = Math.cos(ang), R0 = ends[0].R, R1 = ends[1].R;
  const g = ctx.createLinearGradient(A[0] - nx * R0, A[1] - ny * R0, A[0] + nx * R0, A[1] + ny * R0);
  g.addColorStop(0, paint[0]); g.addColorStop(.45, paint[1]); g.addColorStop(1, paint[2]);
  ctx.fillStyle = g; ctx.beginPath();
  ctx.moveTo(A[0] + nx * R0, A[1] + ny * R0); ctx.lineTo(Bq[0] + nx * R1, Bq[1] + ny * R1);
  ctx.lineTo(Bq[0] - nx * R1, Bq[1] - ny * R1); ctx.lineTo(A[0] - nx * R0, A[1] - ny * R0); ctx.closePath(); ctx.fill();
  // draw the end facing the camera last so it sits on top
  const facing = dot(ax, B.f) > 0 ? 0 : 1;
  for (const e of [1 - facing, facing]) {
    const {P, R, rMinor} = ends[e];
    ctx.fillStyle = e === capAt && paint !== PAINT.ghost ? PAINT.cap[1] : paint[e === facing ? 1 : 2];
    ctx.beginPath(); ctx.ellipse(P[0], P[1], rMinor, R, ang, 0, 7); ctx.fill();
    if (e === capAt && e === facing && paint !== PAINT.ghost) { ctx.fillStyle = PAINT.cap[2]; ctx.beginPath(); ctx.ellipse(P[0], P[1], rMinor * .25, R * .25, ang, 0, 7); ctx.fill(); }
  }
}
// pts = [base, J2, J3, J3 after side step, J4, J5, flange, tcp] (see kinematics.joint_points)
function drawArm(pts, alpha, ghostMode) {
  if (!pts || pts.length !== 8) return;
  const [base, sh, el, st, w1, w2, fl, tcp] = pts;
  const s = Math.min(1.8, Math.max(1, ((profiles[S.model] && profiles[S.model].reach) || 626) / 626));
  const at = (p, dir, d) => add(p, mul(dir, d * s));
  const len = v => Math.hypot(...v), dirOr = (v, fb) => len(v) > 1e-6 ? norm(v) : fb;
  const up = [0, 0, 1], side = dirOr(sub(st, el), [0, 1, 0]);   // joint axis of J2/J3/J4
  const z5 = dirOr(sub(w2, w1), up), z6 = dirOr(sub(fl, w2), up);
  const G = ghostMode ? PAINT.ghost : null, grey = G || PAINT.grey, green = G || PAINT.green, silver = G || PAINT.cap;
  const mid = mul(add(st, w1), .5);
  const parts = [
    [base, at(base, up, 95), 58, grey], [at(base, up, 95), sh, 52, green],
    // The caps face the side the forearm steps towards (matches a photo of the real arm).
    [at(sh, side, -45), at(sh, side, 62), 52, green, 1],              // J2 housing
    [sh, el, 40, grey],                                                 // upper arm
    [at(el, side, -12), at(st, side, 50), 46, green, 1],              // J3 housing incl. side step
    [st, mid, 35, grey], [mid, w1, 35, green],                        // forearm
    [at(w1, side, -40), at(w1, side, 45), 38, green, 1],              // J4
    [w1, at(w2, z5, 32), 36, green, 1],                               // J5
    [w2, at(fl, z6, -14), 34, green], [at(fl, z6, -14), fl, 31, silver, 1], // J6 + flange
  ];
  if (len(sub(tcp, fl)) > 1) parts.push([fl, tcp, 10, grey]);
  parts.sort((a, b) => { const pa = proj(mul(add(a[0], a[1]), .5)), pb = proj(mul(add(b[0], b[1]), .5)); return (pb ? pb[2] : 0) - (pa ? pa[2] : 0); });
  ctx.globalAlpha = alpha;
  for (const [p0, p1, r, paint, capAt] of parts) cyl(p0, p1, r * s, paint, capAt);
  ctx.globalAlpha = 1;
}
function drawFrame(p, R, len, alpha) {
  const cols = ["#ff5c5c", "#3dcd58", "#4c9aff"];
  for (let k = 0; k < 3; k++) { ctx.globalAlpha = alpha; line(p, add(p, [R[0][k] * len, R[1][k] * len, R[2][k] * len]), cols[k], 2); }
  ctx.globalAlpha = 1;
}
let tcpScreen = null, targetScreen = null;
function draw() {
  const dpr = window.devicePixelRatio || 1, rect = cv.getBoundingClientRect();
  if (cv.width !== Math.round(rect.width * dpr) || cv.height !== Math.round(rect.height * dpr)) { cv.width = Math.round(rect.width * dpr); cv.height = Math.round(rect.height * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); W = rect.width; H = rect.height; F = Math.min(H * 1.25, W * 1.6); B = camBasis();
  ctx.clearRect(0, 0, W, H);
  const reach = (profiles[S.model] && profiles[S.model].reach) || 900, ext = Math.ceil(reach * 1.6 / 100) * 100;
  for (let v = -ext; v <= ext; v += 100) { const c = v === 0 ? "#4a4c51" : "#26282b"; line([v, -ext, 0], [v, ext, 0], c, 1); line([-ext, v, 0], [ext, v, 0], c, 1); }
  ctx.strokeStyle = "rgba(232,100,42,.25)"; ctx.setLineDash([6, 6]); ctx.beginPath();
  for (let a = 0; a <= 64; a++) { const P = proj([reach * Math.cos(a / 64 * 6.283), reach * Math.sin(a / 64 * 6.283), 0]); if (P) a ? ctx.lineTo(P[0], P[1]) : ctx.moveTo(P[0], P[1]); }
  ctx.stroke(); ctx.setLineDash([]);
  drawFrame([0, 0, 0], [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 200, .9);
  const bp = []; for (let a = 0; a <= 32; a++) { const P = proj([95 * Math.cos(a / 32 * 6.283), 95 * Math.sin(a / 32 * 6.283), 0]); if (P) bp.push(P); }
  ctx.fillStyle = "#2e3034"; ctx.beginPath(); bp.forEach((P, i) => i ? ctx.lineTo(P[0], P[1]) : ctx.moveTo(P[0], P[1])); ctx.fill();
  if (ghost) drawArm(ghost.points, .35, true);
  drawArm(S.points, 1, false);
  tcpScreen = null; targetScreen = null;
  if (S.tcp) {
    const p = S.tcp.slice(0, 3);
    drawFrame(p, rpyR(S.tcp[3], S.tcp[4], S.tcp[5]), 90, 1);
    const P = proj(p); if (P) { tcpScreen = P; ctx.fillStyle = drag && drag.kind === "tcp" ? "#fff" : "#e8642a"; ctx.beginPath(); ctx.arc(P[0], P[1], 10, 0, 7); ctx.fill(); ctx.strokeStyle = "#0b0e12"; ctx.lineWidth = 2; ctx.stroke(); }
  }
  if (target) {
    const p = target.pose.slice(0, 3), P = proj(p), G = proj([p[0], p[1], 0]);
    if (P && G) {
      ctx.strokeStyle = "rgba(76,154,255,.6)"; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(P[0], P[1]); ctx.lineTo(G[0], G[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = target.ok ? "#4c9aff" : "#e5484d"; ctx.beginPath(); ctx.arc(P[0], P[1], 9, 0, 7); ctx.fill(); targetScreen = P;
    }
  }
  $("hud").innerHTML = S.tcp ? `${S.model_name || ""}<br>X <b>${S.tcp[0].toFixed(1)}</b> Y <b>${S.tcp[1].toFixed(1)}</b> Z <b>${S.tcp[2].toFixed(1)}</b> mm<br>RX <b>${S.tcp[3].toFixed(1)}</b> RY <b>${S.tcp[4].toFixed(1)}</b> RZ <b>${S.tcp[5].toFixed(1)}</b>°`
    : (S.bridge_down ? "bridge not reachable" : S.connected ? "waiting for data…" : "not connected");
  requestAnimationFrame(draw);
}

// mouse & touch: orbit / pan / zoom (wheel or pinch) / drag TCP target (Shift or 2nd finger hold = vertical)
let drag = null, pinch = null;
const pointers = new Map();
cv.addEventListener("contextmenu", e => e.preventDefault());
cv.addEventListener("pointerdown", e => {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  pointers.set(e.pointerId, [x, y]);
  if (pointers.size === 2) {
    if (drag && drag.kind === "tcp") { drag.vertical = true; drag.y0 = y; return; }   // 2nd finger while dragging target = up/down
    const [a, b] = [...pointers.values()];
    pinch = {d: Math.hypot(a[0] - b[0], a[1] - b[1]), dist: cam.dist}; drag = null; return;
  }
  const hit = e.pointerType === "touch" ? 30 : 16;
  const near = P => P && Math.hypot(P[0] - x, P[1] - y) < hit;
  if (e.button === 0 && (near(targetScreen) || near(tcpScreen)) && S.tcp) {
    const base = target ? target.pose : S.tcp.slice();
    drag = {kind: "tcp"};
    if (!target) target = {pose: base.slice(), ok: true};
  } else drag = {kind: e.button === 2 || e.button === 1 ? "pan" : "orbit", x, y};
});
cv.addEventListener("pointermove", e => {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [x, y]);
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    cam.dist = Math.max(300, Math.min(8000, pinch.dist * pinch.d / Math.max(10, Math.hypot(a[0] - b[0], a[1] - b[1])))); return;
  }
  if (!drag) return;
  if (drag.kind === "orbit") { cam.yaw -= (x - drag.x) * 0.008; cam.pitch = Math.max(-0.2, Math.min(1.5, cam.pitch + (y - drag.y) * 0.006)); drag.x = x; drag.y = y; }
  else if (drag.kind === "pan") { const s = cam.dist / F, d = add(mul(B.r, -(x - drag.x) * s), mul(B.u, (y - drag.y) * s)); cam.tx += d[0]; cam.ty += d[1]; cam.tz += d[2]; drag.x = x; drag.y = y; }
  else if (drag.kind === "tcp") {
    if (drag.vertical && e.isPrimary === false) return;   // ignore the helper finger's movement
    if (e.shiftKey || drag.vertical) { const p = rayVertical(x, y, target.pose.slice(0, 3)); if (p) target.pose[2] = p[2]; }
    else { const p = rayPlaneZ(x, y, target.pose[2]); if (p) { target.pose[0] = p[0]; target.pose[1] = p[1]; } }
    requestIK();
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (drag && drag.kind === "tcp") {
    if (drag.vertical && pointers.size === 1) { drag.vertical = false; return; }
    if (pointers.size === 0) { $("targetBar").classList.add("show"); requestIK(); }
  }
  if (pointers.size === 0) drag = null;
}
cv.addEventListener("pointerup", endPointer);
cv.addEventListener("pointercancel", endPointer);
cv.addEventListener("wheel", e => { e.preventDefault(); cam.dist = Math.max(300, Math.min(8000, cam.dist * (e.deltaY > 0 ? 1.1 : 0.9))); }, {passive: false});
let ikBusy = false, ikPending = null;
async function requestIK() {
  ikPending = target.pose.slice();
  if (ikBusy) return; ikBusy = true;
  while (ikPending) {
    const pose = ikPending; ikPending = null;
    const r = await api("/api/ik", {pose, seed: ghost ? ghost.joints : S.joints}).catch(() => ({}));
    if (!target) break;
    if (r.joints) { ghost = {points: r.points, joints: r.joints}; target.ok = r.ok; } else target.ok = false;
    $("targetTxt").textContent = `→ ${pose.slice(0, 3).map(v => v.toFixed(0)).join(", ")} mm` + (target.ok ? "" : "  (unreachable)");
    $("tLin").disabled = $("tJnt").disabled = !target.ok;
  }
  ikBusy = false;
}
window.addEventListener("keydown", e => { if (e.key === "Escape") { api("/api/stop", {}); $("tCancel").onclick(); } });

// ------------------------------------------------------------ boot
(async () => {
  if (!DEMO) {
    const a = await fetch("api/auth").then(r => r.json()).catch(() => ({}));
    if (a.need_pin && !a.ok) { showPin(); return; }
  }
  const m = await api("/api/models"); profiles = m.profiles; limits = m.limits; HOME = m.home;
  for (const sel of ["model", "modelDemo"])
    for (const [k, v] of Object.entries(profiles)) { const o = document.createElement("option"); o.value = k; o.textContent = v.name; $(sel).appendChild(o); }
  buildJog(); drawWps();
  limits.forEach(([lo, hi], i) => { $("js" + i).min = lo; $("js" + i).max = hi; });
  T.subscribe(s => { S = s; render(); });
  setTimeout(syncSliders, 600);
  requestAnimationFrame(draw);
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
