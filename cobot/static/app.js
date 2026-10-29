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
    const mv = w.move === "L" ? "L" : "J";
    d.innerHTML = `<span class="mono">P${i + 1} ${w.tcp.slice(0, 3).map(v => v.toFixed(0)).join(", ")}</span><span class="row"><button class="mv ${mv}" title="J = joint move, L = straight line">${mv}</button><button>Go</button><button>✕</button></span>`;
    const [m, g, x] = d.querySelectorAll("button");
    m.onclick = () => { w.move = mv === "L" ? "J" : "L"; drawWps(); };
    g.onclick = () => wpMove(w);
    x.onclick = () => { waypoints.splice(i, 1); drawWps(); };
    W.appendChild(d);
  });
}
const lspeed = () => +$("cspd").value * 2;
const wpMove = w => w.move === "L"
  ? cmd("moveL", {relFlag: 0, cartPosition: w.tcp, speed: lspeed(), accel: 500})
  : cmd("joint_move", {relFlag: 0, jointPosition: w.joints, speed: jspeed(), accel: 100});
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
      const r = await wpMove(w);
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

// ------------------------------------------------------------ cobot setup (payload, tool, user frame)
// Every write is read back from the cobot, so the page reports whether it really took.
const CFG = {tools: [], users: [], toolId: null, userId: null, key: null};
const near = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) < 1e-3);
const okR = r => r && (r.errorCode === "0" || r.errorCode === 0);
function numOf(id) { const v = parseFloat($(id).value); if (!isFinite(v)) throw new Error("Enter a number in every field"); return v; }
for (const [box, p] of [["toolOff", "to"], ["userOff", "uo"]])
  $(box).innerHTML = CN.map((n, i) => `<label class="f">${n} ${i < 3 ? "mm" : "°"}<input id="${p}${i}" inputmode="decimal"></label>`).join("");
function slotOptions(sel, list, active, zero) {
  const cur = sel.value;
  sel.innerHTML = list.map((o, i) => `<option value="${i}">${i}${i === 0 ? " · " + zero : ""}${i === active ? " (active)" : ""}` +
    `${i && o.some(v => v) ? " · " + o.slice(0, 3).map(v => (+v).toFixed(1)).join(", ") : ""}</option>`).join("");
  sel.value = cur !== "" && +cur < list.length ? cur : String(active ?? 0);
}
function showSlot(p, list, i) { (list[i] || [0, 0, 0, 0, 0, 0]).forEach((v, k) => $(p + k).value = +(+v).toFixed(3)); }
function cfgMsg(t, good) { $("cfgMsg").innerHTML = t; $("cfgMsg").className = "note" + (good ? " ok-msg" : ""); }
async function readCfg() {
  const [pl, to, uo, cs, gd] = await Promise.all(["get_payload", "get_tool_offsets", "get_user_offsets", "get_clsn_sensitivity", "get_data"].map(n => cmd(n)));
  if (okR(pl)) { $("plM").value = pl.mass; ["plX", "plY", "plZ"].forEach((id, k) => $(id).value = pl.centroid[k]); }
  if (okR(to)) CFG.tools = to.tool_offsets;
  if (okR(uo)) CFG.users = uo.user_offsets;
  if (okR(gd)) { CFG.toolId = gd.current_tool_id ?? null; CFG.userId = gd.current_user_id ?? null; }
  $("toolAct").textContent = CFG.toolId ?? "—"; $("userAct").textContent = CFG.userId ?? "—";
  $("clsn").textContent = okR(cs) ? "level " + cs.sensitivityLevel : "—";
  slotOptions($("toolSlot"), CFG.tools, CFG.toolId, "flange"); showSlot("to", CFG.tools, +$("toolSlot").value);
  slotOptions($("userSlot"), CFG.users, CFG.userId, "base"); showSlot("uo", CFG.users, +$("userSlot").value);
  return {pl, to, uo, gd};
}
async function writeCfg(label, name, fields, confirmed) {
  if (S.mode === "real" && !confirm(`Change ${label} on the REAL cobot?`)) return;
  const r = await cmd(name, fields);
  if (!okR(r)) { cfgMsg(`<b>${label}</b>: not changed. ${r.errorMsg || ""}`); return; }
  const after = await readCfg();
  if (confirmed(after)) cfgMsg(`<b>${label}</b>: applied and confirmed by the cobot.`, true);
  else cfgMsg(`<b>${label}</b>: the cobot accepted the command but the value didn't change. Use Cobot Expert for this one.`);
}
const offsets = p => CN.map((_, k) => numOf(p + k));
const guard = fn => async () => { try { await fn(); } catch (e) { cfgMsg(e.message); } };
$("cfgRead").onclick = guard(async () => { await readCfg(); cfgMsg("Read from the cobot.", true); });
$("toolSlot").onchange = () => showSlot("to", CFG.tools, +$("toolSlot").value);
$("userSlot").onchange = () => showSlot("uo", CFG.users, +$("userSlot").value);
$("plSet").onclick = guard(() => {
  const mass = numOf("plM"), centroid = ["plX", "plY", "plZ"].map(numOf);
  return writeCfg(`payload ${mass} kg`, "set_payload", {mass, centroid},
    a => okR(a.pl) && Math.abs(a.pl.mass - mass) < 1e-3 && near(a.pl.centroid, centroid));
});
$("toolSet").onclick = guard(() => {
  const id = +$("toolSlot").value, off = offsets("to");
  if (id === 0) throw new Error("Slot 0 is the bare flange; pick slot 1-10");
  return writeCfg(`tool slot ${id}`, "set_tool_offsets", {id, tooloffset: off, name: "tool" + id}, a => okR(a.to) && near(a.to.tool_offsets[id], off));
});
$("toolUse").onclick = guard(() => {
  const id = +$("toolSlot").value;
  return writeCfg(`active tool → ${id}`, "set_tool_id", {tool_id: id}, a => okR(a.gd) && a.gd.current_tool_id === id);
});
$("userSet").onclick = guard(() => {
  const id = +$("userSlot").value, off = offsets("uo");
  if (id === 0) throw new Error("Slot 0 is the robot base; pick slot 1-10");
  // "userffset" is JAKA's own spelling of the field
  return writeCfg(`user frame ${id}`, "set_user_offsets", {id, userffset: off, name: "user" + id}, a => okR(a.uo) && near(a.uo.user_offsets[id], off));
});
$("userUse").onclick = guard(() => {
  const id = +$("userSlot").value;
  return writeCfg(`active user frame → ${id}`, "set_user_id", {user_frame_id: id}, a => okR(a.gd) && a.gd.current_user_id === id);
});

function showLimits() {
  const L = S.limits || {};
  for (const [id, k] of [["limZ", "z_min"], ["limJ", "joint_speed_max"], ["limL", "linear_speed_max"]])
    if (L[k] != null && document.activeElement !== $(id)) $(id).value = L[k];
}
$("limSet").onclick = guard(async () => {
  const body = {z_min: numOf("limZ"), joint_speed_max: numOf("limJ"), linear_speed_max: numOf("limL")};
  if (body.joint_speed_max <= 0 || body.linear_speed_max <= 0) throw new Error("Speed limits must be above 0");
  const r = await api("/api/limits", body);
  if (r && r.limits) { S.limits = r.limits; showLimits(); cfgMsg("Bridge limits saved.", true); }
});

// ------------------------------------------------------------ TCP calibration (4+ poses touching one point)
// For each pose: R_i t + p_i = P  ->  [R_i  -I] [t; P] = -p_i, solved by least squares.
// t = tool offset in the flange frame, P = the touched point in the base frame.
let tcpPoses = [];
function solveLin(A, b) {   // Gaussian elimination with partial pivoting
  const n = A.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) throw new Error("singular");
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function calibrateTcp(jointsList, model) {
  const arm = new CobotSim.Arm(model);   // bare flange (tool = 0)
  const F = jointsList.map(q => arm.frames(q)[6]);
  const N = Array.from({length: 6}, () => [0, 0, 0, 0, 0, 0]), v = [0, 0, 0, 0, 0, 0];
  for (const T of F) for (let r = 0; r < 3; r++) {
    const row = [T[r][0], T[r][1], T[r][2], r === 0 ? -1 : 0, r === 1 ? -1 : 0, r === 2 ? -1 : 0], rhs = -T[r][3];
    for (let i = 0; i < 6; i++) { v[i] += row[i] * rhs; for (let j = 0; j < 6; j++) N[i][j] += row[i] * row[j]; }
  }
  const u = solveLin(N, v), t = u.slice(0, 3), P = u.slice(3);
  const errs = F.map(T => Math.hypot(...[0, 1, 2].map(r => T[r][0] * t[0] + T[r][1] * t[1] + T[r][2] * t[2] + T[r][3] - P[r])));
  return {t, P, maxErr: Math.max(...errs), rmsErr: Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length)};
}
const tcpBtn = () => { $("tcpRec").textContent = `Record pose (${tcpPoses.length})`; };
$("tcpRec").onclick = () => {
  if (!S.joints) { toast("No live joint data"); return; }
  tcpPoses.push(S.joints.slice()); tcpBtn();
  $("tcpMsg").textContent = tcpPoses.length < 4 ? `${4 - tcpPoses.length} more pose(s) needed; change the angle a lot each time.` : "Enough poses: press Calculate (more poses = better).";
};
$("tcpReset").onclick = () => { tcpPoses = []; tcpBtn(); $("tcpMsg").textContent = ""; };
$("tcpCalc").onclick = () => {
  if (tcpPoses.length < 4) { $("tcpMsg").textContent = "Record at least 4 poses first."; return; }
  let r;
  try { r = calibrateTcp(tcpPoses, S.model || "LXMRL03"); }
  catch (_) { $("tcpMsg").textContent = "Can't solve: the poses are too similar. Tilt the tool much more between poses."; return; }
  const good = r.maxErr < 1.5;
  r.t.forEach((v, k) => $("to" + k).value = +v.toFixed(2));
  for (let k = 3; k < 6; k++) if ($("to" + k).value === "") $("to" + k).value = 0;
  $("tcpMsg").innerHTML = `Tool point X ${r.t[0].toFixed(2)}, Y ${r.t[1].toFixed(2)}, Z ${r.t[2].toFixed(2)} mm from the flange · ` +
    `fit error ${r.rmsErr.toFixed(2)} mm (worst ${r.maxErr.toFixed(2)})` + (good ? " ✓ Filled in above; pick a slot and press Save slot." :
    " ✗ Too large: the tip didn't stay on one point, or the poses are too similar. Reset and try again.");
};

// ------------------------------------------------------------ data recording (CSV)
let rec = null;   // {rows, t0}
$("recBtn").onclick = () => {
  if (rec && rec.on) { rec.on = false; $("recBtn").textContent = "● Record"; $("recBtn").classList.remove("on"); $("recSave").disabled = !rec.rows.length; return; }
  rec = {on: true, rows: [], t0: Date.now()}; $("recBtn").textContent = "■ Stop"; $("recBtn").classList.add("on"); $("recSave").disabled = true;
};
function recSample() {
  if (!rec || !rec.on || !S.joints) return;
  const bits = a => (a || []).slice(0, 16).map(v => v ? 1 : 0).join("");
  rec.rows.push([((Date.now() - rec.t0) / 1000).toFixed(3), ...S.joints.map(v => v.toFixed(3)), ...(S.tcp || []).map(v => v.toFixed(3)),
    ...(S.joint_speed || []).map(v => v.toFixed(2)), S.enabled ? 1 : 0, S.inpos ? 1 : 0, bits(S.din), bits(S.dout)]);
  if (rec.rows.length >= 200000) $("recBtn").onclick();   // ~3 h at 20 Hz
  $("recMsg").textContent = `Recording: ${rec.rows.length} samples, ${((Date.now() - rec.t0) / 1000).toFixed(0)} s`;
}
$("recSave").onclick = () => {
  if (!rec || !rec.rows.length) return;
  const head = ["t_s", ...JN.map(n => n + "_deg"), "x_mm", "y_mm", "z_mm", "rx_deg", "ry_deg", "rz_deg", ...JN.map(n => n + "_deg_s"), "enabled", "inpos", "din0_15", "dout0_15"];
  download(`cobot-recording-${stamp()}.csv`, [head, ...rec.rows].map(r => r.join(",")).join("\n") + "\n", "text/csv");
};

// ------------------------------------------------------------ programs stored on the cobot
let progNames = [], P = {state: null}, progPolled = 0;
try { progNames = JSON.parse(localStorage.getItem("progNames") || "[]"); } catch (_) {}
function drawProgNames() { $("progNames").innerHTML = progNames.map(n => `<option value="${n.replace(/[&"<]/g, c => ({"&": "&amp;", '"': "&quot;", "<": "&lt;"})[c])}">`).join(""); }
drawProgNames();
const quiet = name => T.call(DEMO ? "/api/cmd" : "api/cmd", {cmdName: name}).catch(() => ({}));  // polling: no toasts
async function pollProg(force) {
  if (!S.connected || S.bridge_down || document.hidden) return;
  // poll every 1.5 s while a program runs, otherwise every 5 s
  if (!force && P.state === "idle" && Date.now() - progPolled < 5000) return;
  progPolled = Date.now();
  const [ld, st, ln] = await Promise.all(["get_loaded_program", "get_program_state", "get_current_line"].map(quiet));
  P = {loaded: okR(ld) ? ld.programName : null, state: okR(st) ? st.programState : null, line: okR(ln) ? ln.current_line : null};
  $("progLoaded").textContent = P.loaded || "none"; $("progState").textContent = P.state || "—"; $("progLine").textContent = P.line ?? "—";
  $("progRun").disabled = !(P.loaded && P.state === "idle");
  $("progPause").disabled = P.state !== "running";
  $("progResume").disabled = P.state !== "paused";
}
setInterval(pollProg, 1500);
$("progLoad").onclick = async () => {
  const n = $("progName").value.trim(); if (!n) { toast("Type a program name"); return; }
  if (okR(await cmd("load_program", {programName: n}))) {
    progNames = [n, ...progNames.filter(x => x !== n)].slice(0, 12);
    try { localStorage.setItem("progNames", JSON.stringify(progNames)); } catch (_) {}
    drawProgNames();
  }
  pollProg(true);
};
$("progRun").onclick = async () => {
  if (S.mode === "real" && !confirm(`Run "${P.loaded}" on the REAL cobot?\n\nIt runs at the speeds saved in the program: this page's speed limit doesn't apply. Keep the E-stop in reach.`)) return;
  await cmd("play_program"); pollProg(true);
};
$("progPause").onclick = async () => { await cmd("pause_program"); pollProg(true); };
$("progResume").onclick = async () => {
  if (S.mode === "real" && !confirm(`Resume "${P.loaded}" on the REAL cobot?`)) return;
  await cmd("resume_program"); pollProg(true);
};
$("progStop").onclick = async () => { await cmd("stop_program"); pollProg(true); };

// ------------------------------------------------------------ waypoint files
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
$("wpExport").onclick = () => {
  if (!waypoints.length) { toast("No waypoints to export"); return; }
  download(`waypoints-${stamp()}.json`, JSON.stringify({format: "lexium-cobot-waypoints", version: 1, model: S.model,
    loop: $("loop").checked, pause_s: +$("dwell").value || 0, points: waypoints}, null, 2), "application/json");
};
$("wpImport").onclick = () => $("wpFile").click();
$("wpFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const j = JSON.parse(await f.text()), pts = Array.isArray(j) ? j : j.points;
    if (!Array.isArray(pts) || !pts.every(p => Array.isArray(p.joints) && p.joints.length === 6 && Array.isArray(p.tcp)))
      throw new Error("not a waypoint file");
    if (waypoints.length && !confirm(`Replace the ${waypoints.length} current waypoints with ${pts.length} from ${f.name}?`)) return;
    waypoints = pts.map(p => ({joints: p.joints.map(Number), tcp: p.tcp.map(Number), move: p.move === "L" ? "L" : "J"}));
    if (j.loop != null) $("loop").checked = !!j.loop;
    if (j.pause_s != null) $("dwell").value = j.pause_s;
    drawWps(); toast(`Loaded ${waypoints.length} waypoints`);
  } catch (err) { toast("Import failed: " + err.message); }
};
$("wpClear").onclick = () => { if (waypoints.length && confirm("Delete all waypoints?")) { waypoints = []; drawWps(); } };

// ------------------------------------------------------------ scripting (JavaScript, same names as the Python SDK)
const r1 = v => +(+v).toFixed(2);
function wpScript() {
  if (!waypoints.length) return "// teach some waypoints first\n";
  const lines = ["// generated from waypoints: edit freely", "await robot.speed(" + (S.speed_override ?? Math.round(S.speed_ratio || 100)) + ");", "",
    "const loops = " + ($("loop").checked ? "5" : "1") + ";", "for (let n = 1; n <= loops; n++) {"];
  waypoints.forEach((w, i) => {
    lines.push(w.move === "L"
      ? `  await robot.move_linear([${w.tcp.map(r1).join(", ")}], {speed: ${lspeed()}});   // P${i + 1}`
      : `  await robot.move_joint([${w.joints.map(r1).join(", ")}], {speed: ${jspeed()}});   // P${i + 1}`);
    const d = +$("dwell").value || 0;
    if (d) lines.push(`  await sleep(${d});`);
  });
  lines.push("  log(`cycle ${n} of ${loops}`);", "}", "await robot.home();");
  return lines.join("\n") + "\n";
}
const SC_EXAMPLES = {
  "Square in the air": `// a 100 mm square, 50 mm below the current tool height
await robot.speed(30);
const [x, y, z] = robot.pose;
for (const [dx, dy] of [[100, 0], [100, 100], [0, 100], [0, 0]]) {
  await robot.move_linear({x: x + dx, y: y + dy, z: z - 50}, {speed: 150});
  log("corner", robot.pose.slice(0, 3).map(v => v.toFixed(1)).join(", "));
}
`,
  "Pick and place": `// DO0 = gripper (1 = closed), DI0 = part present. Teach your own poses.
const PICK  = [400, -150, 150, 180, 0, 0];
const PLACE = [400,  150, 150, 180, 0, 0];
const above = (p, dz = 80) => [p[0], p[1], p[2] + dz, p[3], p[4], p[5]];
await robot.speed(30);
for (let n = 1; n <= 3; n++) {
  // await robot.wait_di(0, true, 30);   // uncomment on the real cobot
  await robot.move_pose(above(PICK));
  await robot.set_do(0, false);
  await robot.move_linear(PICK, {speed: 80});
  await robot.set_do(0, true); await sleep(0.3);
  await robot.move_linear(above(PICK));
  await robot.move_pose(above(PLACE));
  await robot.move_linear(PLACE, {speed: 80});
  await robot.set_do(0, false); await sleep(0.3);
  await robot.move_linear(above(PLACE));
  log("cycle", n, "done");
}
await robot.home();
`,
  "Joint wave": `// wiggle the wrist joints from the current pose
await robot.speed(40);
const q = robot.joints;
for (let i = 0; i < 3; i++) {
  await robot.move_joint([0, 0, 0, 15, 15, 30], {relative: true, speed: 60});
  await robot.move_joint([0, 0, 0, -15, -15, -30], {relative: true, speed: 60});
}
await robot.move_joint(q);
`,
  "Wait for an input": `// waits (up to 60 s) for DI0, then blinks DO1 three times
log("waiting for DI0...");
await robot.wait_di(0, true, 60);
for (let i = 0; i < 3; i++) { await robot.set_do(1, true); await sleep(0.5); await robot.set_do(1, false); await sleep(0.5); }
log("done");
`,
};
const SC_DOC = `robot.joints / robot.pose / robot.state      current joints, TCP pose [x,y,z,rx,ry,rz], full status
await robot.move_joint([j1..j6], {speed, accel, relative})      joint move, waits until stopped
await robot.move_linear([x,y,z,rx,ry,rz] or {z: 200}, {speed, accel, relative})   straight line
await robot.move_pose([x,y,z,rx,ry,rz], {speed})   reach a pose with a joint move
await robot.home()      await robot.stop()      await robot.speed(percent)
await robot.power_on() / power_off() / enable() / disable() / clear_error()
await robot.set_do(i, true)    robot.do(i)    robot.di(i)    await robot.wait_di(i, true, timeout_s)
await robot.set_payload(kg, [x,y,z])    await robot.use_tool(slot)
await robot.run_program(name)    await robot.program_state()
P[0].joints / P[0].tcp      your waypoints        await sleep(seconds)      log(...)
Add {wait: false} to a move to continue straight away. Stop aborts at the next command.
Same names as the Python SDK (cobot/sdk.py).`;
for (const k of Object.keys(SC_EXAMPLES)) $("scExample").insertAdjacentHTML("beforeend", `<option>${k}</option>`);
$("scExample").insertAdjacentHTML("beforeend", "<option>From waypoints</option>");
try { $("scCode").value = localStorage.getItem("script") || SC_EXAMPLES["Square in the air"]; } catch (_) { $("scCode").value = SC_EXAMPLES["Square in the air"]; }
$("scCode").addEventListener("input", () => { try { localStorage.setItem("script", $("scCode").value); } catch (_) {} });
$("scCode").addEventListener("keydown", e => {   // Tab indents instead of leaving the editor
  if (e.key !== "Tab") return; e.preventDefault();
  const t = e.target, a = t.selectionStart; t.setRangeText("  ", a, t.selectionEnd, "end");
});
$("scExample").onchange = e => {
  const k = e.target.value; e.target.value = ""; if (!k) return;
  if ($("scCode").value.trim() && !confirm("Replace the current script?")) return;
  $("scCode").value = k === "From waypoints" ? wpScript() : SC_EXAMPLES[k];
  $("scCode").dispatchEvent(new Event("input"));
};
$("wpToScript").onclick = () => {
  if ($("scCode").value.trim() && !confirm("Replace the current script with one made from the waypoints?")) return;
  $("scCode").value = wpScript(); $("scCode").dispatchEvent(new Event("input"));
  const tab = document.querySelector('#tabs button[data-tab="script"]'); if (getComputedStyle($("tabs")).display !== "none") tab.click();
  toast("Script made from waypoints: see the Script card");
};
$("scHelp").onclick = () => { $("scDoc").textContent = SC_DOC; $("scDoc").style.display = $("scDoc").style.display === "none" ? "block" : "none"; };
$("scSave").onclick = () => download(`cobot-script-${stamp()}.js`, $("scCode").value, "text/javascript");
$("scOpen").onclick = () => $("scFile").click();
$("scFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  $("scCode").value = await f.text(); $("scCode").dispatchEvent(new Event("input")); toast("Opened " + f.name);
};

function scLog(cls, ...a) {
  const d = document.createElement("div"); if (cls) d.className = cls;
  d.textContent = a.map(v => typeof v === "object" ? JSON.stringify(v) : String(v)).join(" ");
  $("scOut").appendChild(d); $("scOut").scrollTop = 1e9;
}
let scRun = null;   // {aborted}
function makeRobot(run) {
  const live = () => { if (run.aborted) throw new Error("stopped"); };
  const call = async (name, f = {}) => {
    live();
    const r = await cmd(name, f);
    if (!okR(r)) throw new Error(`${name}: ${r.errorMsg || r.errorCode}`);
    return r;
  };
  const opt = (o, k, d) => (o && o[k] != null ? o[k] : d);
  const settle = async (timeout = 120) => {
    await sleep(250);
    const t0 = Date.now(); let still = 0;
    while (true) {
      live();
      if (S.estop) throw new Error("emergency stop");
      if (S.protective_stop) throw new Error("protective stop (collision?)");
      if (S.errcode) throw new Error(`controller error ${S.errcode}: ${S.errmsg || ""}`);
      still = S.inpos ? still + 1 : 0;
      if (still >= 2) return;
      if (Date.now() - t0 > timeout * 1000) throw new Error("move did not finish in time");
      await sleep(50);
    }
  };
  const AX = ["x", "y", "z", "rx", "ry", "rz"];
  const robot = {
    get state() { return S; }, get joints() { return (S.joints || []).slice(); }, get pose() { return (S.tcp || []).slice(); },
    power_on: () => call("power_on"), power_off: () => call("power_off"), enable: () => call("enable_robot"),
    disable: () => call("disable_robot"), clear_error: () => call("clear_error"),
    stop: () => api("/api/stop", {}),
    speed: pct => call("set_rapidrate", {rapid_rate: Math.max(1, Math.min(100, pct)) / 100}),
    wait_until_stopped: settle,
    async move_joint(q, o = {}) {
      await call("joint_move", {relFlag: o.relative ? 1 : 0, jointPosition: q.map(Number), speed: opt(o, "speed", 30), accel: opt(o, "accel", 100)});
      if (opt(o, "wait", true)) await settle();
    },
    async move_linear(p, o = {}) {
      if (!Array.isArray(p)) { const base = o.relative ? [0, 0, 0, 0, 0, 0] : robot.pose; p = AX.map((a, i) => p[a] != null ? +p[a] : base[i]); }
      await call("moveL", {relFlag: o.relative ? 1 : 0, cartPosition: p.map(Number), speed: opt(o, "speed", 100), accel: opt(o, "accel", 500)});
      if (opt(o, "wait", true)) await settle();
    },
    async move_pose(p, o = {}) {
      live();
      const r = await api("/api/ik", {pose: p.map(Number), seed: robot.joints});
      if (!r.joints || r.ok === false) throw new Error("pose is out of reach");
      await robot.move_joint(r.joints, o);
    },
    home: (o = {}) => robot.move_joint(HOME, o),
    set_do: (i, v = true) => call("set_digital_output", {type: 0, index: i, value: v ? 1 : 0}),
    do: i => !!(S.dout || [])[i], di: i => !!(S.din || [])[i],
    async wait_di(i, v = true, timeout = null) {
      const t0 = Date.now();
      while (robot.di(i) !== !!v) {
        live();
        if (timeout != null && Date.now() - t0 > timeout * 1000) throw new Error(`DI${i} did not become ${v ? 1 : 0} within ${timeout} s`);
        await sleep(20);
      }
    },
    set_payload: (kg, c = [0, 0, 0]) => call("set_payload", {mass: +kg, centroid: c.map(Number)}),
    use_tool: n => call("set_tool_id", {tool_id: +n}),
    async run_program(name) { if (name) await call("load_program", {programName: name}); await call("play_program"); },
    program_state: async () => (await call("get_program_state")).programState,
    command: call,
  };
  return robot;
}
$("scRun").onclick = async () => {
  if (scRun) { toast("A script is already running"); return; }
  if (S.mode === "real" && !confirm("Run this script on the REAL cobot?\n\nThe bridge limits and speed limit apply. Keep the E-stop in reach.")) return;
  const run = scRun = {aborted: false};
  $("scOut").innerHTML = ""; $("scRun").disabled = true;
  const Async = Object.getPrototypeOf(async function () {}).constructor;
  const t0 = Date.now();
  try {
    const fn = new Async("robot", "sleep", "log", "P", $("scCode").value);
    await fn(makeRobot(run), async s => { const end = Date.now() + s * 1000; while (Date.now() < end) { if (run.aborted) throw new Error("stopped"); await sleep(Math.min(50, end - Date.now())); } },
      (...a) => scLog("", ...a), waypoints.map(w => ({...w})));
    scLog("", `✓ finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    scLog("e", (run.aborted ? "■ " : "✗ ") + e.message);
    if (!run.aborted) api("/api/stop", {});
  } finally { scRun = null; $("scRun").disabled = false; }
};
$("scStop").onclick = () => { if (scRun) scRun.aborted = true; api("/api/stop", {}); };

// ------------------------------------------------------------ status rendering
let shownMode = null;
function pill(id, cls, txt) { const p = $(id); p.className = "pill " + cls; if (txt) p.textContent = txt; }
function render() {
  recSample();
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
  // read the cobot's setup + program state once per connection
  const cfgKey = S.connected && !S.bridge_down && (S.joints || S.mode === "demo") ? `${S.mode}|${S.host}` : null;
  if (cfgKey && cfgKey !== CFG.key) { CFG.key = cfgKey; readCfg().catch(() => {}); pollProg(true); showLimits(); }
  if (!cfgKey) CFG.key = null;
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
    // real cobot: its own override stays at 100% (it ignores set_rapidrate); the bridge's limit is what applies
    const spd = S.mode === "real" && S.speed_override != null ? `speed limit ${S.speed_override}%` : `speed ${S.speed_ratio.toFixed(0)}%`;
    $("cab").textContent = `${S.cab_temp.toFixed(1)} °C · ${S.cab_power.toFixed(0)} W · ${spd}`;
    for (let k = 0; k < 16; k++) { $("do" + k).classList.toggle("on", !!(S.dout && S.dout[k])); $("di" + k).classList.toggle("on", !!(S.din && S.din[k])); }
    // real cobot: the bridge enforces the limit (the cobot's own override stays at 100%)
    const eff = Math.round(S.mode === "real" && S.speed_override != null ? S.speed_override : S.speed_ratio);
    for (const [sl, lab] of [["speed", "speedV"], ["speed2", "speedV2"]])
      if (document.activeElement !== $(sl)) { $(sl).value = eff; $(lab).textContent = eff + "%"; }
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
let tcpScreen = null, targetScreen = null, lastPts = null, lastPtsAsked = false;
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
  // no live data (cobot unreachable, bridge down): keep the last known pose, faded, instead of an empty scene
  if (S.points) lastPts = S.points;
  else if (!lastPts && !lastPtsAsked) { lastPtsAsked = true; api("/api/fk", {joints: [0, 90, -90, 90, 90, 0]}).then(r => { if (r.points && !lastPts) lastPts = r.points; }).catch(() => { lastPtsAsked = false; }); }
  drawArm(S.points || lastPts, S.points ? 1 : .3, false);
  if (!S.points) {
    const msg = S.bridge_down ? "Bridge not reachable: is the app still running on the PC?"
      : S.mode === "real" ? `No data from the cobot${S.host ? " at " + S.host : ""}: check the PC is on the cobot Wi-Fi`
      : S.connected ? "Waiting for data…" : "Not connected: Setup → Connect";
    ctx.font = "600 14px system-ui, sans-serif"; ctx.textAlign = "center";
    const tw = ctx.measureText(msg).width + 28;
    ctx.fillStyle = "rgba(29,30,32,.85)"; ctx.fillRect(W / 2 - tw / 2, 18, tw, 32);
    ctx.strokeStyle = "#e8642a"; ctx.lineWidth = 1; ctx.strokeRect(W / 2 - tw / 2, 18, tw, 32);
    ctx.fillStyle = "#fff"; ctx.fillText(msg, W / 2, 39); ctx.textAlign = "start";
  }
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
