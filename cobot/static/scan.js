// Scan tab: a SICK TiM 2D LiDAR on the flange, simulated or real (read by the bridge, cobot/tim.py). The arm carries the scanner in a straight line
// over items standing still on the table: the same as items riding a belt under a fixed scanner. Each scan line is
// placed with the arm's live pose, so the lines build a 3D point cloud; the cross-section of every line times the
// distance travelled gives the volume (the same sum as a belt volume scanner).
// Uses app.js globals ($, S, cmd, api, toast, sleep, download, stamp, proj, ctx, add, sub, mul, dot, norm, rpyR,
// matMul, matT, box, cyl, okR, jspeed, claim, release, busy, note, FEAT, B, F, GRIP, saveGrip, readCfg).
// Names here start with tim/TIM: classic scripts share one global scope with app.js and draw.js.
"use strict";

// ------------------------------------------------------------ settings (remembered on this device)
const TIM = {
  mounted: false, free: false,
  // where the scans come from: "sim" (ray-cast here) or "real" (a TiM read by the bridge at host:port)
  source: "sim", host: "192.168.0.1", port: 2111, flip: false, lag: 0,
  // scanner: a 2D LiDAR fan in the plane of the flange's Y and Z axes, looking along flange Z (down)
  fov: 270, res: 0.33, rate: 15, range: 10000, noise: 1,
  // the pass: the scanner's optical centre moves in a straight line, `height` above the belt surface (330 mm keeps
  // the belt at least 0.3 m from the SEC110's lens: its shortest working distance)
  sx: 340, sy: -180, dir: 90, len: 360, height: 330, speed: 100, beltZ: 0, beltW: 400,
  show: {items: true, cloud: true, belt: true},
};
// The printed mount in hardware/tim-sec-mount: the TiM lies on its side under a plate on the flange, hood axis along
// flange X, front (90° beam) down, so its scan plane is the flange's Y-Z plane. The scan origin is L mm out from the
// flange face. Mass = TiM 0.25 kg + SEC110 camera 0.12 kg + printed bracket and screws (about 0.13 kg).
const TIM_BODY = {L: 62.5, mass: 0.5, com: 45};
// shapes for the 3D view, in the flange frame (mm): centre [x, y, z] and half sizes, from tim_sec_mount.scad
const TIM_MOUNT = [
  {c: [9.8, 0, 5], h: [78.7, 35.4, 5], col: [232, 100, 42]},          // plate on the flange
  {c: [-47.2, 0, 54.2], h: [20.7, 35.4, 44.2], col: [214, 92, 38]},   // cradle around the TiM's base end (36 mm)
  {c: [-33.2, 0, 62.5], h: [29.2, 30, 30.5], col: [70, 74, 82]},      // TiM body
];
let timItems = null;
try {
  const s = JSON.parse(localStorage.getItem("tim") || "{}");
  timItems = Array.isArray(s.items) ? s.items : null; delete s.items;
  Object.assign(TIM, s, {show: Object.assign(TIM.show, s.show || {})});
} catch (_) {}
const TIM_SAMPLE = () => [
  {type: "box", x: 330, y: -90, a: 140, b: 90, h: 70, rot: 15},
  {type: "cyl", x: 375, y: 55, a: 80, h: 110},
  {type: "ball", x: 290, y: 110, a: 70},
  {type: "box", x: 400, y: -10, a: 60, b: 60, h: 35, rot: 40},
];
if (!timItems) timItems = TIM_SAMPLE();
const timSave = () => { try { localStorage.setItem("tim", JSON.stringify({...TIM, items: timItems})); } catch (_) {} };

// the recorded scan: one entry per scan line
let timLines = [];        // {o: [x,y,z] scanner, ex: travel axis, pts: Float32Array xyz of hits, h: Float32Array heights, area}
let timVol = 0, timTravel = 0, timPoints = 0, timMaxH = 0;
// volume bookkeeping: progress is measured along the first direction the scanner moved (across its scan plane);
// only ground not scanned yet adds volume, so jogging back and forth doesn't count it twice
let timRef = null, timFront = 0, timLastArea = 0;
const TIM_MAX_POINTS = 400000;
const TIM_BIN = 5;          // mm: width of the bins across the belt for the cross-section

// ------------------------------------------------------------ ray casting against the belt and the items
// how far across the belt the scan counts: the belt edges, or less where the fan doesn't reach that far
function timHalfWidth() {
  const reach = Math.sqrt(Math.max(0, TIM.range ** 2 - TIM.height ** 2));
  return Math.min(TIM.beltW / 2, TIM.fov >= 179 ? reach : Math.min(reach, TIM.height * Math.tan(TIM.fov / 2 * Math.PI / 180)));
}
const timThr = () => Math.max(2, 3 * TIM.noise);   // heights below this count as belt
function timHit(o, d) {
  let best = TIM.range;
  const zb = TIM.beltZ;
  if (d[2] < -1e-9) { const t = (zb - o[2]) / d[2]; if (t > 0 && t < best) best = t; }
  for (const it of timItems) {
    const t = it.type === "box" ? hitBox(o, d, it) : it.type === "cyl" ? hitCyl(o, d, it) : hitBall(o, d, it);
    if (t > 0 && t < best) best = t;
  }
  return best < TIM.range ? best : null;
}
function hitBox(o, d, it) {
  // into the box's frame: turned by -rot about Z, origin at its centre
  const a = -(it.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const ox = o[0] - it.x, oy = o[1] - it.y, oz = o[2] - (TIM.beltZ + it.h / 2);
  const O = [ox * c - oy * s, ox * s + oy * c, oz], D = [d[0] * c - d[1] * s, d[0] * s + d[1] * c, d[2]];
  const h = [it.a / 2, (it.b || it.a) / 2, it.h / 2];
  let t0 = -Infinity, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(D[k]) < 1e-12) { if (Math.abs(O[k]) > h[k]) return -1; continue; }
    let ta = (-h[k] - O[k]) / D[k], tb = (h[k] - O[k]) / D[k];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return -1;
  }
  return t0 > 0 ? t0 : -1;
}
function hitCyl(o, d, it) {
  const r = it.a / 2, z0 = TIM.beltZ, z1 = z0 + it.h, ox = o[0] - it.x, oy = o[1] - it.y;
  let best = -1;
  const A = d[0] * d[0] + d[1] * d[1];
  if (A > 1e-12) {   // the side
    const Bq = 2 * (ox * d[0] + oy * d[1]), C = ox * ox + oy * oy - r * r, disc = Bq * Bq - 4 * A * C;
    if (disc >= 0) {
      const t = (-Bq - Math.sqrt(disc)) / (2 * A), z = o[2] + t * d[2];
      if (t > 0 && z >= z0 && z <= z1) best = t;
    }
  }
  if (Math.abs(d[2]) > 1e-12) {   // the top
    const t = (z1 - o[2]) / d[2], x = ox + t * d[0], y = oy + t * d[1];
    if (t > 0 && x * x + y * y <= r * r && (best < 0 || t < best)) best = t;
  }
  return best;
}
function hitBall(o, d, it) {
  const r = it.a / 2, c = [it.x, it.y, TIM.beltZ + r], oc = sub(o, c);
  const b = dot(oc, d), C = dot(oc, oc) - r * r, disc = b * b - C;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : -1;
}
// gaussian noise for the range (Box–Muller)
const timRandn = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

// one scan from the flange pose: scanner frame = flange frame, optical centre L mm along flange Z
function timCast(fl, Rf, noisy) {
  const ex = [Rf[0][0], Rf[1][0], Rf[2][0]], ey = [Rf[0][1], Rf[1][1], Rf[2][1]], ez = [Rf[0][2], Rf[1][2], Rf[2][2]];
  const o = add(fl, mul(ez, TIM_BODY.L)), n = Math.max(2, Math.round(TIM.fov / Math.max(0.05, TIM.res)) + 1);
  const hits = [];
  for (let k = 0; k < n; k++) {
    const th = (-TIM.fov / 2 + TIM.fov * k / (n - 1)) * Math.PI / 180;
    const d = add(mul(ez, Math.cos(th)), mul(ey, Math.sin(th)));
    let t = timHit(o, d);
    if (t == null) { hits.push(null); continue; }
    if (noisy && TIM.noise > 0) t += timRandn() * TIM.noise;
    hits.push(add(o, mul(d, t)));
  }
  return {o, ex, ey, hits};
}

// A real scan (bridge /api/tim/stream: start angle, step, ranges in mm, 0 = no echo) placed at a flange pose.
// TiM angles: 90° is out of its front face. On the printed mount the front points along flange Z (down) and the
// hood along flange X, which makes angle a the direction cos(a)·Y + sin(a)·Z; "flip" mirrors it (if the mount is
// turned the other way round).
function timRealCast(scan, fl, Rf) {
  const ex = [Rf[0][0], Rf[1][0], Rf[2][0]], ey = [Rf[0][1], Rf[1][1], Rf[2][1]], ez = [Rf[0][2], Rf[1][2], Rf[2][2]];
  const o = add(fl, mul(ez, TIM_BODY.L)), hits = [], sg = TIM.flip ? -1 : 1;
  for (let k = 0; k < scan.dist.length; k++) {
    const r = scan.dist[k];
    if (!(r > 0 && r < TIM.range)) { hits.push(null); continue; }
    const a = (scan.start + scan.step * k) * Math.PI / 180;
    hits.push(add(o, add(mul(ey, sg * Math.cos(a) * r), mul(ez, Math.sin(a) * r))));
  }
  return {o, ex, ey, hits};
}
const TIMREAL = {es: null, state: null, last: null, lastT: 0};
function timRealOpen() {
  if (DEMO || TIMREAL.es) return;
  const es = new EventSource("api/tim/stream");
  es.onmessage = ev => {
    const m = JSON.parse(ev.data); TIMREAL.state = m.state;
    if (m.scan) { TIMREAL.last = m.scan; TIMREAL.lastT = performance.now(); timRealScan(m.scan); }
  };
  es.onerror = () => { es.close(); TIMREAL.es = null; if (TIM.source === "real") setTimeout(timRealOpen, 2000); };
  TIMREAL.es = es;
}
function timRealClose() { if (TIMREAL.es) { TIMREAL.es.close(); TIMREAL.es = null; } }
function timRealScan(scan) {
  if (TIM.source !== "real" || !FEAT.scan || !TIM.mounted || !(TIMJOB.recording || TIM.free) || scan.error) return;
  if (timFull()) return;
  // the scan was taken a little before it arrived: use the pose from then (TIM.lag adds the scanner's own delay)
  const p = timPoseAt(performance.now() - 80 - TIM.lag); if (!p) return;
  const sc = timRealCast(scan, p.fl, p.Rf), last = timLines[timLines.length - 1];
  if (last && Math.hypot(...sub(sc.o, last.o)) < 0.2) return;
  timAddLine(sc);
}
function timFull() {
  if (timPoints < TIM_MAX_POINTS) return false;
  if (!timTick.full) { timTick.full = true; toast("Scan memory full (400 000 points): Clear scan to record more"); }
  return true;
}

// flange position + rotation from a status message (rotation = TCP rotation with the active tool's rotation taken out)
function timFlange(s) {
  if (!s || !s.tcp || !s.points || s.points.length !== 8) return null;
  const t = s.tool || [0, 0, 0, 0, 0, 0];
  return {fl: s.points[6].slice(), Rf: matMul(rpyR(s.tcp[3], s.tcp[4], s.tcp[5]), matT(rpyR(t[3], t[4], t[5])))};
}

// ------------------------------------------------------------ recording at the scanner's own rate
// The status feed comes at about 20 Hz; the scanner runs at its own rate (15 Hz on a TiM), so the flange
// pose is interpolated between status messages, 80 ms in the past so there is always a newer message to lerp to.
const timHist = [];
function timFeed(s) {
  const f = timFlange(s); if (!f) return;
  timHist.push({t: performance.now(), ...f});
  while (timHist.length > 40) timHist.shift();
}
function timPoseAt(t) {
  const H = timHist; if (H.length < 2) return null;
  let i = H.length - 1;
  while (i > 0 && H[i - 1].t > t) i--;
  if (i === 0) return H[0];
  const a = H[i - 1], b = H[i], k = Math.max(0, Math.min(1, (t - a.t) / Math.max(1, b.t - a.t)));
  return {fl: a.fl.map((v, j) => v + (b.fl[j] - v) * k), Rf: k < .5 ? a.Rf : b.Rf};
}
let timTimer = null;
function timRestartTimer() {
  clearInterval(timTimer);
  timTimer = setInterval(timTick, 1000 / Math.max(1, Math.min(100, TIM.rate)));
}
function timTick() {
  if (TIM.source !== "sim" || !FEAT.scan || !TIM.mounted || !(TIMJOB.recording || TIM.free)) return;
  if (timFull()) return;
  const p = timPoseAt(performance.now() - 80); if (!p) return;
  const last = timLines[timLines.length - 1];
  const sc = timCast(p.fl, p.Rf, true);
  if (last && Math.hypot(...sub(sc.o, last.o)) < 0.2) return;   // standing still: no new line
  timAddLine(sc);
}
function timAddLine(sc) {
  // Cross-section: the line's points go into fixed bins across the belt and each bin takes the mean height, so range
  // noise averages out instead of scrambling the order of neighbouring points. A bin with no points is a shadow
  // behind an item (the scanner can't see into it): it takes the lower of its nearest neighbours, a vertical edge.
  const pts = [], hs = [], hw = TIM.beltW / 2, nb = Math.max(1, Math.round(TIM.beltW / TIM_BIN)), cw = TIM.beltW / nb;
  const sum = new Float64Array(nb), cnt = new Uint16Array(nb);
  for (const p of sc.hits) {
    if (!p) continue;
    // only the belt counts: beyond its edges the fan sees the floor at grazing angles, far apart and noisy
    const lat = dot(sub(p, sc.o), sc.ey); if (Math.abs(lat) > hw) continue;
    const h = p[2] - TIM.beltZ;
    pts.push(p[0], p[1], p[2]); hs.push(h);
    if (h > timMaxH) timMaxH = h;
    const b = Math.min(nb - 1, Math.floor((lat + hw) / cw)); sum[b] += h; cnt[b]++;
  }
  const hb = Array.from(sum, (v, b) => cnt[b] ? v / cnt[b] : null);
  let area = 0;
  for (let b = 0; b < nb; b++) {
    let v = hb[b];
    if (v == null) {
      let l = b - 1, r = b + 1;
      while (l >= 0 && hb[l] == null) l--;
      while (r < nb && hb[r] == null) r++;
      const L = l >= 0 ? hb[l] : null, R = r < nb ? hb[r] : null;
      v = L == null ? (R ?? 0) : R == null ? L : Math.min(L, R);
    }
    area += v * cw;
  }
  const line = {o: sc.o, ex: sc.ex, pts: new Float32Array(pts), h: new Float32Array(hs), area};
  if (!timRef) { timRef = {o: sc.o, ex: sc.ex, sign: 0}; timFront = 0; timLastArea = area; }
  else {
    const along = dot(sub(sc.o, timRef.o), timRef.ex);
    if (!timRef.sign && Math.abs(along) > 0.5) timRef.sign = Math.sign(along);
    const prog = along * (timRef.sign || 1), inc = prog - timFront;
    if (inc > 0) {
      // a gap much larger than the line spacing is a jump (recording paused, a fast jog): no volume across it
      const gap = Math.max(150, 4 * TIM.speed / Math.max(1, TIM.rate));
      if (inc < gap) { timVol += (area + timLastArea) / 2 * inc; timTravel += inc; }
      timFront = prog; timLastArea = area;
    }
  }
  timLines.push(line); timPoints += hs.length;
}
function timClear() { timLines = []; timVol = timTravel = timPoints = timMaxH = timFront = timLastArea = 0; timRef = null; timTick.full = false; timShow(); }

// ------------------------------------------------------------ the pass as robot moves
// desired scanner pose → TCP pose for the active tool: flange = optical centre - L along flange Z; TCP = flange + Rf·tool
function timTcpFor(p) {
  const a = TIM.dir * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const Rf = [[c, s, 0], [s, -c, 0], [0, 0, -1]];   // Rz(dir)·Rx(180): travel along flange X, flange Z straight down
  const t = S.tool || [0, 0, 0, 0, 0, 0], Rt = rpyR(t[3], t[4], t[5]);
  const ez = [Rf[0][2], Rf[1][2], Rf[2][2]], fl = sub(p, mul(ez, TIM_BODY.L));
  const tcp = add(fl, Rf.map(r => r[0] * t[0] + r[1] * t[1] + r[2] * t[2]));
  return [...tcp, ...timRpy(matMul(Rf, Rt))];
}
function timRpy(R) {
  const d = 180 / Math.PI, sy = -R[2][0];
  if (Math.abs(sy) < 0.999999) return [Math.atan2(R[2][1], R[2][2]) * d, Math.asin(sy) * d, Math.atan2(R[1][0], R[0][0]) * d];
  return [Math.atan2(-R[1][2], R[1][1]) * d, Math.sign(sy) * 90, 0];
}
function timEnds() {
  const a = TIM.dir * Math.PI / 180, z = TIM.beltZ + TIM.height;
  return [[TIM.sx, TIM.sy, z], [TIM.sx + TIM.len * Math.cos(a), TIM.sy + TIM.len * Math.sin(a), z]];
}

const TIMJOB = {active: false, recording: false};
async function timMoveWait(send, goal) {
  const r = await send();
  if (!okR(r)) throw new Error(r.errorMsg || "move refused");
  const t0 = Date.now();
  let settled = 0;
  for (;;) {
    await sleep(40);
    if (!TIMJOB.active) throw new Error("stopped");
    if (S.estop || S.protective_stop || S.enabled === false) throw new Error("robot not ready (E-stop, protective stop or disabled)");
    if (S.errcode) throw new Error(`controller error ${S.errcode}${S.errmsg ? ": " + S.errmsg : ""}`);
    if (S.mode === "real" && !S.stream_ok && Date.now() - t0 > 3000) throw new Error("lost the status feed from the cobot");
    const there = S.tcp && Math.hypot(S.tcp[0] - goal[0], S.tcp[1] - goal[1], S.tcp[2] - goal[2]) < 1;
    if (S.inpos !== false && there) { if (++settled >= 2) return; } else settled = 0;
    if (S.inpos !== false && !there && Date.now() - t0 > 2500) throw new Error("the arm stopped before reaching the point");
  }
}

$("sRun").onclick = async () => {
  if (TIMJOB.active || busy("scan")) return;
  if (!S.connected || !S.tcp) { toast("Not connected"); return; }
  if (S.errcode) { toast("Clear the controller error first (Robot tab → Clear error)"); return; }
  if (!TIM.mounted) { await timMount(true); }
  if (TIM.source === "real" && !(TIMREAL.state && TIMREAL.state.connected)) { timMsg("The real TiM isn't sending scans: Connect it under Scanner first"); return; }
  const [p0, p1] = timEnds(), c0 = timTcpFor(p0), c1 = timTcpFor(p1);
  const zMin = (S.limits || {}).z_min;
  if (zMin != null && Math.min(c0[2], c1[2]) < zMin) { timMsg(`The pass is below the floor limit (${zMin} mm): raise Height or lower the floor limit in Setup`); return; }
  let q0;
  for (const [i, c] of [c0, c1, timTcpFor(p0.map((v, k) => (v + p1[k]) / 2))].entries()) {
    const r = await api("/api/ik", {pose: c, seed: S.joints});
    if (!r.joints || !r.ok) { timMsg(`The ${["start", "end", "middle"][i]} of the pass is out of reach: move it closer to the arm, lower Height or shorten Length`); return; }
    if (i === 0) q0 = r.joints;
  }
  if (S.mode === "real" && !confirm(`Run the scan pass with the REAL arm?\n\n${TIM.source === "real" ? "The real TiM records" : "The scanner and the items are simulated, but the arm moves"}: ${TIM.len} mm straight line at ${TIM.speed} mm/s (the speed limit still applies), ${TIM.height} mm above the belt surface. Area clear, E-stop in reach.`)) return;
  if (!FEAT.scan || !claim("scan")) return;
  TIMJOB.active = true;
  $("sRun").disabled = true;
  const t0 = Date.now();
  try {
    timMsg("moving to the start of the pass…");
    const fk = await api("/api/fk", {joints: q0});
    await timMoveWait(() => cmd("joint_move", {relFlag: 0, jointPosition: q0, speed: jspeed(), accel: 100}), fk.tcp || c0);
    timMsg(`scanning: ${TIM.len} mm at ${TIM.speed} mm/s…`);
    TIMJOB.recording = true;
    await timMoveWait(() => cmd("moveL", {relFlag: 0, cartPosition: c1, speed: TIM.speed, accel: 500}), c1);
    await sleep(150);   // the last lines come in behind the status feed
    timMsg(`✓ pass done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } catch (e) {
    if (e.message !== "stopped") { api("/api/stop", {}); toast("Scan stopped: " + e.message); }
    timMsg(e.message === "stopped" ? "■ stopped" : "✗ " + e.message);
    note(`scan stopped: ${e.message}`);
  } finally {
    TIMJOB.active = TIMJOB.recording = false; release("scan"); $("sRun").disabled = false; timShow();
  }
};
$("sStop").onclick = () => { if (TIMJOB.active) { TIMJOB.active = false; api("/api/stop", {}); } };
const timMsg = t => { $("sProg").textContent = t; };

// scanner on/off: in the simulator it also becomes tool slot 1 (optical centre) with its weight as payload
async function timMount(on) {
  const was = TIM.mounted;
  TIM.mounted = on; $("sMount").checked = on; timSave();
  if (!on) {
    // simulator: put back the tool and payload that were active before the scanner went on
    if (was && TIM.prev && S.mode !== "real") {
      await cmd("set_tool_id", {tool_id: TIM.prev.toolId});
      if (TIM.prev.payload) await cmd("set_payload", TIM.prev.payload);
      readCfg().catch(() => {});
    }
    TIM.prev = null; timSave(); timShow(); return;
  }
  if (GRIP.model) { $("gModel").value = ""; saveGrip(); }   // one thing on the flange at a time
  if (S.mode === "real") { toast("Virtual scanner shown on the real arm: its tool and payload are not changed"); timShow(); return; }
  if (!was) {
    const pl = await cmd("get_payload");
    TIM.prev = {toolId: S.tool_id ?? 0, payload: okR(pl) ? {mass: pl.mass, centroid: pl.centroid} : null}; timSave();
  }
  const rs = [await cmd("set_tool_offsets", {id: 1, tooloffset: [0, 0, TIM_BODY.L, 0, 0, 0], name: "TiM scanner"}),
              await cmd("set_tool_id", {tool_id: 1}),
              await cmd("set_payload", {mass: TIM_BODY.mass, centroid: [0, 0, TIM_BODY.com]})];
  readCfg().catch(() => {});
  if (!rs.every(okR)) toast("Simulator didn't accept the scanner tool: " + (rs.find(r => !okR(r)).errorMsg || "error"));
  // the pass is planned from S.tool: wait until the status feed reports the new tool
  for (let t = 0; t < 40 && !(S.tool && Math.abs(S.tool[2] - TIM_BODY.L) < 0.01); t++) await sleep(50);
  timShow();
}
$("sMount").onchange = e => timMount(e.target.checked);
// scanner source: simulated, or the real TiM through the bridge
function timSource(src) {
  TIM.source = src === "real" && !DEMO ? "real" : "sim"; timSave();
  if (TIM.source === "real") timRealOpen(); else timRealClose();
  timShow();
}
$("sSrc").onchange = e => timSource(e.target.value);
$("sTimConn").onclick = async () => {
  TIM.host = $("sHost").value.trim() || TIM.host; TIM.port = +$("sPort").value || 2111; timSave();
  const r = await api("/api/tim/connect", {host: TIM.host, port: TIM.port, proto: "auto"});
  if (!r.errorCode) { TIMREAL.state = r; timSource("real"); }
};
$("sTimDisc").onclick = async () => { await api("/api/tim/disconnect", {}); TIMREAL.state = null; timShow(); };
$("sFlip").onchange = e => { TIM.flip = e.target.checked; timSave(); };
$("sLag").onchange = e => { TIM.lag = Math.max(0, Math.min(500, +e.target.value || 0)); timSave(); timShow(); };
function timRealText() {
  if (DEMO) return "Real TiM: needs the app on a PC (the bridge reads the scanner), not the browser demo.";
  const st = TIMREAL.state;
  if (!st || !st.host) return "Real TiM: not connected. Default address 192.168.0.1 port 2111 (put the PC on the TiM's subnet).";
  if (st.connected) return `Real TiM ${st.host}:${st.port}: <b style="color:var(--ok)">${st.rate} scans/s</b>, CoLa ${st.proto}, ${st.scans.toLocaleString()} scans`;
  return `Real TiM ${st.host}:${st.port}: <b style="color:var(--warn)">${st.running ? "connecting…" : "stopped"}</b>${st.error ? " " + st.error : ""}`;
}
setInterval(() => { if (TIM.source === "real") $("sTimSt").innerHTML = timRealText(); }, 500);
$("sFree").onchange = e => { TIM.free = e.target.checked; timSave(); };
$("sClear").onclick = timClear;
$("sHere").onclick = () => {
  const f = timFlange(S); if (!f) { toast("No position from the cobot yet"); return; }
  const ez = [f.Rf[0][2], f.Rf[1][2], f.Rf[2][2]], o = add(f.fl, mul(ez, TIM_BODY.L));
  TIM.sx = Math.round(o[0]); TIM.sy = Math.round(o[1]); timSave(); timShow();
};
for (const [id, k] of [["sShowItems", "items"], ["sShowCloud", "cloud"], ["sShowBelt", "belt"]])
  $(id).onchange = e => { TIM.show[k] = e.target.checked; timSave(); };

const TIM_FIELDS = [["sSX", "sx"], ["sSY", "sy"], ["sDir", "dir"], ["sLen", "len", 1], ["sHt", "height", 20], ["sSpd", "speed", 1], ["sBelt", "beltZ"], ["sBeltW", "beltW", 20],
                    ["sFov", "fov", 5, 270], ["sRes", "res", 0.1, 5], ["sRate", "rate", 1, 100], ["sRange", "range", 100], ["sNoise", "noise", 0, 50]];
for (const [id, k, lo, hi] of TIM_FIELDS) $(id).onchange = () => {
  let v = parseFloat($(id).value);
  if (isFinite(v)) { if (lo != null) v = Math.max(lo, v); if (hi != null) v = Math.min(hi, v); TIM[k] = v; }
  if (k === "rate") timRestartTimer();
  timSave(); timShow();
};

// ------------------------------------------------------------ items list
const TIM_KINDS = {box: "Box", cyl: "Cylinder", ball: "Ball"};
function timItemsHtml() {
  const esc = v => +(+v || 0).toFixed(1);
  $("sItems").innerHTML = timItems.length ? `<div class="timrow timhead"><span>X</span><span>Y</span><span>L / Ø</span><span>W</span><span>H</span><span>turn°</span><span></span></div>` +
    timItems.map((it, i) => `<div class="timrow" data-i="${i}"><b>${TIM_KINDS[it.type]}</b>` +
      ["x", "y", "a", "b", "h", "rot"].map(k => {
        const off = (k === "b" || k === "rot") && it.type !== "box" || k === "h" && it.type === "ball";
        return `<input data-k="${k}" inputmode="decimal" value="${off ? "" : esc(it[k])}"${off ? " disabled" : ""}>`;
      }).join("") + `<button data-del="${i}" title="Remove">✕</button></div>`).join("")
    : `<div class="note" style="margin:0">No items: the scan shows the empty belt.</div>`;
}
$("sItems").addEventListener("change", e => {
  const row = e.target.closest(".timrow"), k = e.target.dataset.k; if (!row || !k) return;
  const it = timItems[+row.dataset.i], v = parseFloat(e.target.value);
  if (isFinite(v)) it[k] = ["a", "b", "h"].includes(k) ? Math.max(5, v) : v;
  timSave(); timItemsHtml(); timShow();
});
$("sItems").addEventListener("click", e => {
  const d = e.target.dataset.del; if (d == null) return;
  timItems.splice(+d, 1); timSave(); timItemsHtml(); timShow();
});
const timAdd = it => { timItems.push(it); timSave(); timItemsHtml(); timShow(); };
$("sAddBox").onclick = () => timAdd({type: "box", x: TIM.sx, y: TIM.sy + TIM.len / 2, a: 100, b: 80, h: 60, rot: 0});
$("sAddCyl").onclick = () => timAdd({type: "cyl", x: TIM.sx, y: TIM.sy + TIM.len / 2, a: 70, h: 100});
$("sAddBall").onclick = () => timAdd({type: "ball", x: TIM.sx, y: TIM.sy + TIM.len / 2, a: 60});
$("sSample").onclick = () => { timItems = TIM_SAMPLE(); timSave(); timItemsHtml(); timShow(); };

// ------------------------------------------------------------ text: settings, what the pass gives, the result
const timTrueVol = () => timItems.reduce((v, it) => v + (it.type === "box" ? it.a * (it.b || it.a) * it.h
  : it.type === "cyl" ? Math.PI * (it.a / 2) ** 2 * it.h : 4 / 3 * Math.PI * (it.a / 2) ** 3), 0);
const cm3 = v => v >= 1e6 ? `${(v / 1e6).toFixed(2)} L` : `${(v / 1000).toFixed(0)} cm³`;
function timShow() {
  for (const [id, k] of TIM_FIELDS) if (document.activeElement !== $(id)) $(id).value = +(+TIM[k]).toFixed(2);
  $("sMount").checked = TIM.mounted; $("sFree").checked = TIM.free;
  $("sSrc").value = TIM.source; $("sFlip").checked = TIM.flip; $("sTimSt").innerHTML = timRealText();
  if (document.activeElement !== $("sHost")) $("sHost").value = TIM.host;
  if (document.activeElement !== $("sPort")) $("sPort").value = TIM.port;
  if (document.activeElement !== $("sLag")) $("sLag").value = TIM.lag;
  document.body.classList.toggle("tim-real", TIM.source === "real");
  $("sShowItems").checked = TIM.show.items; $("sShowCloud").checked = TIM.show.cloud; $("sShowBelt").checked = TIM.show.belt;
  const beams = Math.round(TIM.fov / TIM.res) + 1, spacing = TIM.speed / TIM.rate, width = 2 * timHalfWidth();
  const lateral = TIM.height * TIM.res * Math.PI / 180;
  $("sInfo").innerHTML = `${beams} beams per line, ${TIM.rate} lines/s. At ${TIM.speed} mm/s the lines are <b style="color:var(--text)">${spacing.toFixed(1)} mm apart</b>` +
    ` along the pass and the beams about ${lateral.toFixed(1)} mm apart across it, over a ${width.toFixed(0)} mm wide strip of belt.` +
    (TIM.mounted ? "" : ` <b style="color:var(--warn)">Tick "scanner on the flange" (Scan does it for you).</b>`);
  if (!timLines.length) { $("sResult").innerHTML = "No scan yet: press <b>Scan</b>, or tick <i>record while jogging</i> and jog over the items."; return; }
  const tv = TIM.source === "sim" ? timTrueVol() : 0, err = tv > 0 ? ` (${timVol >= tv ? "+" : ""}${((timVol / tv - 1) * 100).toFixed(1)} %)` : "";
  $("sResult").innerHTML = `${timLines.length} lines, ${timPoints.toLocaleString()} points over ${timTravel.toFixed(0)} mm. Highest point ${timMaxH.toFixed(1)} mm above the belt.<br>` +
    `Volume on the belt: <b style="color:var(--text)">${cm3(timVol)}</b> measured` + (tv > 0 ? `, ${cm3(tv)} true${err}` : "") + "." +
    ` <span style="color:var(--mute)">Overhangs (the lower half of a ball) look solid from above, and items outside the strip aren't seen.</span>`;
}
setInterval(() => { if (TIMJOB.recording || TIM.free) timShow(); }, 500);

// ------------------------------------------------------------ exports
$("sPly").onclick = () => {
  if (!timPoints) { toast("Nothing scanned yet"); return; }
  const rows = [];
  for (const l of timLines) for (let i = 0; i < l.h.length; i++) rows.push(`${l.pts[3 * i].toFixed(2)} ${l.pts[3 * i + 1].toFixed(2)} ${l.pts[3 * i + 2].toFixed(2)}`);
  const head = `ply\nformat ascii 1.0\ncomment Lexium Cobot ${TIM.source === "real" ? "" : "simulated "}TiM scan, ${new Date().toISOString().slice(0, 16)}, base frame mm, belt at Z ${TIM.beltZ}\nelement vertex ${rows.length}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`;
  download(`scan-${stamp()}.ply`, head + rows.join("\n") + "\n", "text/plain");
};
$("sCsv").onclick = () => {
  if (!timPoints) { toast("Nothing scanned yet"); return; }
  const rows = ["line,x_mm,y_mm,z_mm,height_mm"];
  timLines.forEach((l, k) => { for (let i = 0; i < l.h.length; i++) rows.push(`${k},${l.pts[3 * i].toFixed(2)},${l.pts[3 * i + 1].toFixed(2)},${l.pts[3 * i + 2].toFixed(2)},${l.h[i].toFixed(2)}`); });
  download(`scan-${stamp()}.csv`, rows.join("\n") + "\n", "text/csv");
};

// ------------------------------------------------------------ 3D view
PAINT.tim = ["#f3e08a", "#d8b62c", "#8a7212"];
PAINT.can = ["#b6c8e6", "#6f8fc0", "#3c5a8c"];
// under the arm: the belt strip of the pass, the items, then the point cloud
function drawTimScene() {
  const zb = TIM.beltZ, [p0, p1] = timEnds();
  // the pass: the strip of belt the fan covers, and the scanner's path above it
  if (TIM.mounted || timLines.length) {
    const a = TIM.dir * Math.PI / 180, nx = -Math.sin(a), ny = Math.cos(a), hw = Math.min(timHalfWidth(), 1500);
    const C = [[p0, 1], [p1, 1], [p1, -1], [p0, -1]].map(([p, s]) => proj([p[0] + nx * hw * s, p[1] + ny * hw * s, zb]));
    if (C.every(Boolean)) {
      ctx.fillStyle = "rgba(60,64,72,.55)"; ctx.beginPath(); C.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(232,100,42,.35)"; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.setLineDash([5, 5]); line(p0, p1, "rgba(232,100,42,.7)", 1.5); ctx.setLineDash([]);
    const P = proj(p1);   // end of the pass
    if (P) { ctx.fillStyle = "rgba(232,100,42,.8)"; ctx.beginPath(); ctx.arc(P[0], P[1], 4, 0, 7); ctx.fill(); }
  }
  if (TIM.show.items && TIM.source === "sim") {
    const items = timItems.map(it => ({it, z: (proj([it.x, it.y, zb + (it.h || it.a) / 2]) || [0, 0, 0])[2]})).sort((u, v) => v.z - u.z);
    ctx.globalAlpha = timLines.length && TIM.show.cloud ? .45 : .95;
    for (const {it} of items) {
      if (it.type === "box") {
        const r = (it.rot || 0) * Math.PI / 180, ax = [[Math.cos(r), Math.sin(r), 0], [-Math.sin(r), Math.cos(r), 0], [0, 0, 1]];
        box([it.x, it.y, zb + it.h / 2], ax, [it.a / 2, (it.b || it.a) / 2, it.h / 2], [196, 158, 108]);
      } else if (it.type === "cyl") cyl([it.x, it.y, zb], [it.x, it.y, zb + it.h], it.a / 2, PAINT.can);
      else {
        const P = proj([it.x, it.y, zb + it.a / 2]); if (!P) continue;
        const R = it.a / 2 * F / P[2], g = ctx.createRadialGradient(P[0] - R * .35, P[1] - R * .4, R * .1, P[0], P[1], R);
        g.addColorStop(0, "#ffe7b8"); g.addColorStop(.6, "#e0a050"); g.addColorStop(1, "#7a4d1c");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(P[0], P[1], R, 0, 7); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
  if (TIM.show.cloud && timPoints) timDrawCloud();
}
// points coloured by height above the belt (blue low → red high); drawn in 24 colour bins, one fill each
function timDrawCloud() {
  const NB = 24, bins = Array.from({length: NB}, () => []), belt = [], thr = timThr();
  const hmax = Math.max(20, timMaxH), stride = Math.max(1, Math.ceil(timPoints / 70000));
  let k = 0;
  for (const l of timLines) for (let i = 0; i < l.h.length; i++) {
    if (k++ % stride) continue;
    const h = l.h[i];
    if (h <= thr && !TIM.show.belt) continue;
    const P = proj([l.pts[3 * i], l.pts[3 * i + 1], l.pts[3 * i + 2]]); if (!P) continue;
    (h <= thr ? belt : bins[Math.min(NB - 1, Math.floor(h / hmax * NB))]).push(P[0], P[1]);
  }
  const fill = (arr, style, s) => {
    if (!arr.length) return;
    ctx.fillStyle = style; ctx.beginPath();
    for (let i = 0; i < arr.length; i += 2) ctx.rect(arr[i] - s / 2, arr[i + 1] - s / 2, s, s);
    ctx.fill();
  };
  fill(belt, "rgba(140,150,170,.55)", 1.6);
  bins.forEach((arr, b) => fill(arr, `hsl(${(230 - 230 * b / (NB - 1)).toFixed(0)},90%,58%)`, 2.2));
}
// over the arm: the scanner body and its laser fan (live, from the current pose)
function drawTimScanner() {
  if (!TIM.mounted) return;
  const f = timFlange(S); if (!f) return;
  const {fl, Rf} = f, ex = [Rf[0][0], Rf[1][0], Rf[2][0]], ey = [Rf[0][1], Rf[1][1], Rf[2][1]], ez = [Rf[0][2], Rf[1][2], Rf[2][2]];
  const real = TIM.source === "real", fresh = real && TIMREAL.last && performance.now() - TIMREAL.lastT < 1000;
  const sc = real ? (fresh ? timRealCast(TIMREAL.last, fl, Rf) : {o: add(fl, mul(ez, TIM_BODY.L)), hits: []}) : timCast(fl, Rf, false);
  // fan: a few beams as faint lines, and the red laser line where it lands
  ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,60,60,.16)";
  const O = proj(sc.o);
  if (O) {
    ctx.beginPath();
    const step = Math.max(1, Math.round(sc.hits.length / 24));
    sc.hits.forEach((p, i) => { if (!p || i % step) return; const P = proj(p); if (P) { ctx.moveTo(O[0], O[1]); ctx.lineTo(P[0], P[1]); } });
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,70,70,.95)"; ctx.lineWidth = 2; ctx.beginPath();
  let on = false;
  for (const p of sc.hits) { const P = p && proj(p); if (!P) { on = false; continue; } on ? ctx.lineTo(P[0], P[1]) : ctx.moveTo(P[0], P[1]); on = true; }
  ctx.stroke();
  // the mount, the TiM (body + round hood on the scan plane) and the tilted camera, drawn far to near
  const P = ([x, y, z]) => add(fl, add(mul(ex, x), add(mul(ey, y), mul(ez, z))));
  const t = -15 * Math.PI / 180, cx = add(mul(ex, Math.cos(t)), mul(ez, -Math.sin(t))), cz = add(mul(ex, Math.sin(t)), mul(ez, Math.cos(t)));
  const parts = TIM_MOUNT.map(m => ({c: P(m.c), draw: () => box(P(m.c), [ex, ey, ez], m.h, m.col)}));
  parts.push({c: P([9.6, 0, 62.5]), draw: () => cyl(P([-4, 0, 62.5]), P([23.3, 0, 62.5]), 25, PAINT.tim)});
  const camC = add(P([62, 0, 44]), mul(cz, 16.8));
  parts.push({c: camC, draw: () => box(camC, [cx, ey, cz], [24.5, 28.75, 16.8], [70, 110, 150])});
  parts.sort((a, b) => dot(sub(b.c, B.eye), B.f) - dot(sub(a.c, B.eye), B.f));
  for (const p of parts) p.draw();
}

if (DEMO) TIM.source = "sim";
timItemsHtml(); timShow(); timRestartTimer();
if (TIM.source === "real") timRealOpen();
