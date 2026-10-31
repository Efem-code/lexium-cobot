// Draw tab: import G-code, place it on a sheet of paper in front of the cobot, preview it in the 3D view,
// then draw it with straight-line moves (pen in the tool). Also exports the finished path for a TM262 PLC.
// Uses app.js globals ($, S, cmd, api, toast, sleep, download, stamp, proj, ctx, add, mul, sub, okR).
"use strict";

// ------------------------------------------------------------ G-code → strokes (paper mm)
// Pen down is taken from, in this order: Z words (Z at or below "down at Z" = down), M3/M4 (down) and M5 (up),
// or else G1/G2/G3 = drawing and G0 = travel.
function parseGcode(text, zDown = 0) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\([^)]*\)/g, "").replace(/;.*/, "").trim().toUpperCase());
  const words = l => [...l.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)].map(m => [m[1], +m[2]]);
  const hasZ = lines.some(l => /Z\s*[-+.\d]/.test(l));
  const hasM = lines.some(l => /\bM0?[345]\b/.test(l));
  let x = 0, y = 0, z = null, abs = true, unit = 1, motion = 0, spindle = false;
  const strokes = [], warn = new Set();
  let cur = null;
  const down = () => hasZ ? (z != null && z <= zDown) : hasM ? spindle : motion !== 0;
  const penTo = (nx, ny) => {
    if (down()) {
      if (!cur) { cur = [[x, y]]; strokes.push(cur); }
      cur.push([nx, ny]);
    } else cur = null;
    x = nx; y = ny;
  };
  for (const l of lines) {
    if (!l) continue;
    const W = words(l), g = W.filter(w => w[0] === "G").map(w => w[1]), get = k => { const w = W.find(w => w[0] === k); return w ? w[1] : null; };
    for (const m of W.filter(w => w[0] === "M").map(w => w[1])) {
      if (m === 3 || m === 4) spindle = true;
      if (m === 5) spindle = false;
      if (m === 2 || m === 30) break;
    }
    for (const c of g) {
      if (c === 20) unit = 25.4; else if (c === 21) unit = 1;
      else if (c === 90) abs = true; else if (c === 91) abs = false;
      else if ([0, 1, 2, 3].includes(c)) motion = c;
      else if (![4, 17, 28, 54, 64, 61, 40, 49, 80, 94, 90.1, 91.1].includes(c)) warn.add("G" + c + " ignored");
    }
    const X = get("X"), Y = get("Y"), Z = get("Z");
    if (Z != null) { const nz = Z * unit; z = abs || z == null ? nz : z + nz; if (!(X != null || Y != null)) cur = down() ? cur : null; }
    if (X == null && Y == null) { if (!down()) cur = null; continue; }
    const nx = X == null ? x : abs ? X * unit : x + X * unit, ny = Y == null ? y : abs ? Y * unit : y + Y * unit;
    if (motion === 2 || motion === 3) {
      // arc: centre from I/J (always relative to the start) or radius R; split into short chords (≤ 0.05 mm off the arc)
      let cx, cy, R = get("R");
      if (R != null) {
        R *= unit;
        const dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy);
        if (d < 1e-9 || Math.abs(R) < d / 2 - 1e-6) { warn.add("bad arc skipped"); penTo(nx, ny); continue; }
        const h = Math.sqrt(Math.max(0, R * R - d * d / 4)) * ((motion === 2) === (R > 0) ? -1 : 1);
        cx = x + dx / 2 - dy / d * h; cy = y + dy / 2 + dx / d * h;
      } else { cx = x + (get("I") || 0) * unit; cy = y + (get("J") || 0) * unit; }
      const r = Math.hypot(x - cx, y - cy);
      let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx), sw = a1 - a0;
      if (motion === 2) { if (sw >= -1e-9) sw -= 2 * Math.PI; } else if (sw <= 1e-9) sw += 2 * Math.PI;
      const step = r > 0.05 ? 2 * Math.acos(1 - 0.05 / r) : Math.PI, n = Math.max(1, Math.ceil(Math.abs(sw) / step));
      for (let k = 1; k <= n; k++) {
        const a = a0 + sw * k / n;
        penTo(k === n ? nx : cx + r * Math.cos(a), k === n ? ny : cy + r * Math.sin(a));
      }
    } else penTo(nx, ny);
  }
  const out = strokes.map(simplify).filter(s => s.length > 1);
  return {strokes: out, warn: [...warn], penRule: hasZ ? `Z ≤ ${zDown} = pen down` : hasM ? "M3 = pen down, M5 = up" : "G1/G2/G3 = drawing, G0 = travel"};
}
// drop points closer than 0.1 mm, then Douglas–Peucker at 0.1 mm: fewer, longer moves for the arm
function simplify(pts, tol = 0.1) {
  const p = [pts[0]];
  for (const q of pts.slice(1)) if (Math.hypot(q[0] - p[p.length - 1][0], q[1] - p[p.length - 1][1]) >= 0.1) p.push(q);
  if (p.length < 3) return p.length === 1 && pts.length > 1 ? [pts[0], pts[pts.length - 1]] : p;
  const keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
  const st = [[0, p.length - 1]];
  while (st.length) {
    const [i, j] = st.pop(), [ax, ay] = p[i], [bx, by] = p[j], L = Math.hypot(bx - ax, by - ay);
    let worst = -1, wi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = L < 1e-9 ? Math.hypot(p[k][0] - ax, p[k][1] - ay) : Math.abs((bx - ax) * (ay - p[k][1]) - (ax - p[k][0]) * (by - ay)) / L;
      if (d > worst) { worst = d; wi = k; }
    }
    if (worst > tol) { keep[wi] = 1; st.push([i, wi], [wi, j]); }
  }
  return p.filter((_, k) => keep[k]);
}
function bbox(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const [x, y] of s) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return {x0, y0, x1, y1, w: x1 - x0, h: y1 - y0};
}

// ------------------------------------------------------------ settings (remembered on this device)
const DRAW = {paperW: 216, paperH: 279, rot: 0, scale: 100, dx: 0, dy: 0, lift: 10, press: 0.5, zDown: 0,
              drawSpeed: 30, travelSpeed: 80, origin: null, start: null, finish: null};
try { Object.assign(DRAW, JSON.parse(localStorage.getItem("draw") || "{}")); } catch (_) {}
let drawing = null;   // {name, text, strokes, warn, penRule}
let ink = [];         // what the pen has drawn so far: polylines in base mm
const saveDraw = () => { try { localStorage.setItem("draw", JSON.stringify(DRAW)); } catch (_) {} };
const FIELDS = [["dPW", "paperW"], ["dPH", "paperH"], ["dRot", "rot"], ["dScale", "scale"], ["dDX", "dx"], ["dDY", "dy"],
                ["dLift", "lift"], ["dPress", "press"], ["dZDown", "zDown"], ["dSpd", "drawSpeed"], ["dTrv", "travelSpeed"]];
function showDraw() {
  for (const [id, k] of FIELDS) if (document.activeElement !== $(id)) $(id).value = +(+DRAW[k]).toFixed(2);
  const f = p => p ? p.slice(0, 3).map(v => v.toFixed(0)).join(", ") : "not set";
  $("dOrigin").textContent = f(DRAW.origin);
  $("dStartTxt").textContent = DRAW.start ? "set" : "not set";
  $("dFinishTxt").textContent = DRAW.finish ? "set" : "not set";
  if (!drawing) { $("dInfo").textContent = "No drawing loaded. Open a G-code file (Inkscape, svg2gcode…) or load the sample."; return; }
  const b = bbox(drawing.strokes), s = DRAW.scale / 100, len = drawing.strokes.reduce((a, st) => a + st.slice(1).reduce((q, p, i) => q + Math.hypot(p[0] - st[i][0], p[1] - st[i][1]), 0), 0) * s;
  const moves = drawing.strokes.reduce((a, st) => a + st.length + 2, 0);
  const mins = (len / DRAW.drawSpeed + moves * 0.25) / 60;
  const off = !paperFits() ? ` <b style="color:var(--bad)">Runs off the paper</b>` : "";
  $("dInfo").innerHTML = `<b style="color:var(--text)">${drawing.name}</b>: ${drawing.strokes.length} strokes, ${moves} moves, ${(b.w * s).toFixed(0)} × ${(b.h * s).toFixed(0)} mm, about ${Math.max(1, Math.round(mins))} min at ${DRAW.drawSpeed} mm/s.${off}<br>Pen: ${drawing.penRule}.` +
    (drawing.warn.length ? ` <span style="color:var(--warn)">${drawing.warn.join(", ")}</span>` : "");
}
function paperFits() {
  if (!drawing) return true;
  const b = bbox(drawing.strokes), s = DRAW.scale / 100;
  return b.x0 * s + DRAW.dx >= -0.5 && b.y0 * s + DRAW.dy >= -0.5 && b.x1 * s + DRAW.dx <= DRAW.paperW + 0.5 && b.y1 * s + DRAW.dy <= DRAW.paperH + 0.5;
}
for (const [id, k] of FIELDS) $(id).onchange = () => {
  const v = parseFloat($(id).value);
  if (isFinite(v)) DRAW[k] = k === "scale" ? Math.max(1, v) : ["lift", "drawSpeed", "travelSpeed"].includes(k) ? Math.max(1, v) : v;
  saveDraw(); showDraw();
};

// paper mm (G-code X/Y after scale + offset) → cobot base mm; the paper's X axis is the base X axis turned by "Rotate"
function toBase(u, v, z) {
  const o = DRAW.origin, a = DRAW.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [o[0] + u * c - v * s, o[1] + u * s + v * c, o[2] + z];
}
const paperXY = ([x, y]) => [x * DRAW.scale / 100 + DRAW.dx, y * DRAW.scale / 100 + DRAW.dy];

// the whole job as straight-line moves: [{p: [x,y,z], down}] in base mm, with the pen lifted between strokes
function plan() {
  const ops = [], zd = -DRAW.press, zu = DRAW.lift;
  for (const st of drawing.strokes) {
    const P = st.map(paperXY);
    ops.push({p: toBase(...P[0], zu), down: false});
    for (const q of P) ops.push({p: toBase(...q, zd), down: true});
    ops.push({p: toBase(...P[P.length - 1], zu), down: false});
  }
  return ops;
}

// ------------------------------------------------------------ buttons
$("dOpen").onclick = () => $("dFile").click();
$("dFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  loadDrawing(f.name, await f.text());
};
function loadDrawing(name, text) {
  const r = parseGcode(text, DRAW.zDown);
  if (!r.strokes.length) { toast(`${name}: no pen-down moves found (${r.penRule})`); return; }
  drawing = {name, text, ...r}; ink = [];
  if (!paperFits()) $("dFit").onclick(); else showDraw();
}
$("dZDown").addEventListener("change", () => { if (drawing) loadDrawing(drawing.name, drawing.text); });
$("dSample").onclick = () => loadDrawing("sample-star.gcode", SAMPLE_GCODE);
$("dFit").onclick = () => {
  if (!drawing) return;
  const b = bbox(drawing.strokes), m = 15, s = Math.min((DRAW.paperW - 2 * m) / Math.max(b.w, 1e-6), (DRAW.paperH - 2 * m) / Math.max(b.h, 1e-6));
  DRAW.scale = +(s * 100).toFixed(1);
  DRAW.dx = +((DRAW.paperW - b.w * s) / 2 - b.x0 * s).toFixed(1); DRAW.dy = +((DRAW.paperH - b.h * s) / 2 - b.y0 * s).toFixed(1);
  saveDraw(); showDraw();
};
$("dSetOrigin").onclick = () => {
  if (!S.tcp) { toast("No position from the cobot yet"); return; }
  DRAW.origin = [...S.tcp]; saveDraw(); showDraw();
  toast("Paper corner set: the pen draws in this orientation, and this height is \"touching the paper\"");
};
$("dSetStart").onclick = () => { if (S.joints) { DRAW.start = [...S.joints]; saveDraw(); showDraw(); } };
$("dSetFinish").onclick = () => { if (S.joints) { DRAW.finish = [...S.joints]; saveDraw(); showDraw(); } };
$("dClrStart").onclick = () => { DRAW.start = null; saveDraw(); showDraw(); };
$("dClrFinish").onclick = () => { DRAW.finish = null; saveDraw(); showDraw(); };
$("dGoStart").onclick = () => DRAW.start && cmd("joint_move", {relFlag: 0, jointPosition: DRAW.start, speed: jspeed(), accel: 100});
$("dGoFinish").onclick = () => DRAW.finish && cmd("joint_move", {relFlag: 0, jointPosition: DRAW.finish, speed: jspeed(), accel: 100});
$("dClearInk").onclick = () => { ink = []; };

// ------------------------------------------------------------ running the job
const JOB = {active: false, paused: false, i: 0, ops: null, down: false};
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// send one move and wait until the arm is there (the status feed says in position and the TCP is within 1 mm)
async function moveAndWait(send, goal) {
  const r = await send();
  if (!okR(r)) throw new Error(r.errorMsg || "move refused");
  const t0 = Date.now();
  let settled = 0;
  for (;;) {
    await sleep(40);
    if (!JOB.active) throw new Error("stopped");
    if (S.estop || S.protective_stop || S.enabled === false) throw new Error("robot not ready (E-stop, protective stop or disabled)");
    if (S.errcode) throw new Error(`controller error ${S.errcode}${S.errmsg ? ": " + S.errmsg : ""}`);
    if (S.mode === "real" && !S.stream_ok && Date.now() - t0 > 3000) throw new Error("lost the status feed from the cobot");
    const there = goal ? S.tcp && dist3(S.tcp, goal) < 1 : true;
    if (S.inpos !== false && there) { if (++settled >= 2) return; } else settled = 0;
    // in position but not at the point: the move ended early (or never started)
    if (S.inpos !== false && !there && Date.now() - t0 > 2500) throw new Error("the arm stopped before reaching the point");
  }
}
const moveL = (p, speed) => moveAndWait(() => cmd("moveL", {relFlag: 0, cartPosition: [...p, ...DRAW.origin.slice(3)], speed, accel: 500}), p);
async function moveJ(q) {
  const fk = await api("/api/fk", {joints: q});
  return moveAndWait(() => cmd("joint_move", {relFlag: 0, jointPosition: q, speed: jspeed(), accel: 100}), fk.tcp ? fk.tcp.slice(0, 3) : null);
}

async function checkJob(ops) {
  if (!DRAW.origin) throw new Error("Set the paper corner first (jog the pen tip onto the corner, then Set corner)");
  const zMin = (S.limits || {}).z_min;
  const low = Math.min(...ops.map(o => o.p[2]));
  if (zMin != null && low < zMin) throw new Error(`Pen-down height ${low.toFixed(1)} mm is below the floor limit (${zMin} mm): lower the floor limit in Setup, or reduce "Press"`);
  // the paper corners and the first and last points must be reachable in the pen orientation
  const b = bbox(drawing.strokes.map(st => st.map(paperXY)));
  const probe = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].flatMap(([u, v]) => [toBase(u, v, -DRAW.press), toBase(u, v, DRAW.lift)]);
  for (const p of probe) {
    const r = await api("/api/ik", {pose: [...p, ...DRAW.origin.slice(3)], seed: S.joints});
    if (!r.joints || !r.ok) throw new Error(`Part of the drawing is out of the arm's reach (near X ${p[0].toFixed(0)} Y ${p[1].toFixed(0)}): move the paper closer or make the drawing smaller`);
  }
}

$("dRun").onclick = async () => {
  if (JOB.active) return;
  if (!drawing) { toast("Load a drawing first"); return; }
  if (!S.connected) { toast("Not connected"); return; }
  if (S.errcode) { toast("Clear the controller error first (Robot tab → Clear error)"); return; }
  const ops = plan();
  try { await checkJob(ops); } catch (e) { toast(e.message); $("dProg").textContent = e.message; return; }
  if (S.mode === "real" && !confirm(`Draw "${drawing.name}" with the REAL arm?\n\n${ops.length} moves at up to ${DRAW.drawSpeed} mm/s (the speed limit still applies). Paper taped down, pen holder fitted, area clear, E-stop in reach.`)) return;
  Object.assign(JOB, {active: true, paused: false, i: 0, ops, down: false});
  ink = [];
  runJob();
};
$("dPause").onclick = () => {
  if (!JOB.active) return;
  JOB.paused = !JOB.paused;
  $("dPause").textContent = JOB.paused ? "Resume" : "Pause";
};
$("dStop").onclick = () => { if (JOB.active) { JOB.active = false; api("/api/stop", {}); } };

async function runJob() {
  $("dRun").disabled = true; $("dPause").textContent = "Pause";
  const t0 = Date.now(), ops = JOB.ops;
  try {
    if (DRAW.start) { $("dProg").textContent = "moving to start…"; await moveJ(DRAW.start); }
    // reach the first point with a joint move: a long straight line from anywhere can pass a singularity
    if (JOB.i === 0) {
      const r = await api("/api/ik", {pose: [...ops[0].p, ...DRAW.origin.slice(3)], seed: S.joints});
      if (!r.joints || !r.ok) throw new Error("can't reach the first point");
      $("dProg").textContent = "moving above the paper…";
      await moveJ(r.joints); JOB.i = 1;
    }
    while (JOB.i < ops.length) {
      if (JOB.paused) {
        // lift the pen straight up, wait, then come back down where it left off
        const here = S.tcp.slice(0, 3), wasDown = JOB.down;
        if (wasDown) { await moveL([here[0], here[1], DRAW.origin[2] + DRAW.lift], DRAW.travelSpeed); JOB.down = false; }
        $("dProg").textContent = `paused at move ${JOB.i} of ${ops.length}`;
        while (JOB.paused && JOB.active) await sleep(100);
        if (!JOB.active) throw new Error("stopped");
        if (wasDown) { await moveL([here[0], here[1], DRAW.origin[2] + DRAW.lift], DRAW.travelSpeed); await moveL(here, DRAW.drawSpeed); JOB.down = true; }
      }
      const o = ops[JOB.i];
      JOB.down = o.down && JOB.i > 0 && ops[JOB.i - 1].down;   // drawing while moving between two pen-down points
      if (o.down && !JOB.down) ink.push([]);   // pen goes down: a new line of ink
      await moveL(o.p, o.down && JOB.down ? DRAW.drawSpeed : DRAW.travelSpeed);
      if (o.down && ink.length) ink[ink.length - 1].push(o.p);
      JOB.i++;
      $("dProg").textContent = `${Math.round(JOB.i / ops.length * 100)} % · move ${JOB.i} of ${ops.length} · ${((Date.now() - t0) / 1000).toFixed(0)} s`;
    }
    JOB.down = false;
    if (DRAW.finish) { $("dProg").textContent = "moving to finish…"; await moveJ(DRAW.finish); }
    $("dProg").textContent = `✓ finished in ${((Date.now() - t0) / 1000).toFixed(0)} s`;
  } catch (e) {
    if (e.message !== "stopped") api("/api/stop", {});
    $("dProg").textContent = (e.message === "stopped" ? "■ stopped" : "✗ " + e.message) + ` at move ${JOB.i} of ${ops.length}`;
    if (e.message !== "stopped") toast("Drawing stopped: " + e.message);
  } finally {
    JOB.active = false; JOB.paused = false; JOB.down = false;
    $("dRun").disabled = false; $("dPause").textContent = "Pause";
  }
}

// ------------------------------------------------------------ 3D view: paper, the drawing, and the ink so far
function drawPaper() {
  if (!DRAW.origin || $("dShow").checked === false) return;
  const z = 0, c = [[0, 0], [DRAW.paperW, 0], [DRAW.paperW, DRAW.paperH], [0, DRAW.paperH]].map(([u, v]) => proj(toBase(u, v, z)));
  if (c.some(p => !p)) return;
  ctx.fillStyle = "rgba(245,245,240,.9)"; ctx.beginPath(); c.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 1; ctx.stroke();
  const path = (pts, color, w) => {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
    let on = false;
    for (const p of pts) { const q = proj(p); if (!q) { on = false; continue; } on ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); on = true; }
    ctx.stroke();
  };
  if (drawing) {
    ctx.lineJoin = ctx.lineCap = "round";
    // planned lines, light; pen-up travel, dashed
    for (const st of drawing.strokes) path(st.map(q => toBase(...paperXY(q), z)), "rgba(232,100,42,.45)", 1.2);
    if (!JOB.active) {
      ctx.setLineDash([3, 5]);
      for (let k = 1; k < drawing.strokes.length; k++) {
        const a = drawing.strokes[k - 1], b = drawing.strokes[k];
        path([toBase(...paperXY(a[a.length - 1]), z), toBase(...paperXY(b[0]), z)], "rgba(0,0,0,.18)", 1);
      }
      ctx.setLineDash([]);
    }
  }
  // ink: finished segments, plus the live pen position while it is on the paper
  for (let k = 0; k < ink.length; k++) {
    const pts = ink[k].map(p => [p[0], p[1], DRAW.origin[2]]);
    if (k === ink.length - 1 && JOB.down && S.tcp) pts.push([S.tcp[0], S.tcp[1], DRAW.origin[2]]);
    if (pts.length > 1) path(pts, "#1b2a6b", 2.2);
  }
}

// ------------------------------------------------------------ TM262 export
// The finished path as Structured Text: a DUT and a GVL to paste into Machine Expert (Add Object → DUT / Global Variable List).
// Every point is in the cobot's base frame (mm); the tool orientation is the same for all points.
$("dPlc").onclick = () => {
  if (!drawing) { toast("Load a drawing first"); return; }
  if (!DRAW.origin) { toast("Set the paper corner first"); return; }
  const ops = plan(), f = v => (+v).toFixed(2), ori = DRAW.origin.slice(3);
  const joints = q => q ? `[${q.map(f).join(", ")}]` : "[6(0.0)]";
  const rows = ops.map((o, k) => `\t\t(x := ${f(o.p[0])}, y := ${f(o.p[1])}, z := ${f(o.p[2])}, bPenDown := ${o.down ? "TRUE" : "FALSE"})${k < ops.length - 1 ? "," : ""}`);
  const st = `(* Lexium Cobot drawing "${drawing.name}", exported ${new Date().toISOString().slice(0, 16)} by the Lexium Cobot app.
   ${ops.length} points in the cobot base frame (mm). Paper corner X ${f(DRAW.origin[0])} Y ${f(DRAW.origin[1])} Z ${f(DRAW.origin[2])},
   rotation ${DRAW.rot} deg, scale ${DRAW.scale} %, lift ${DRAW.lift} mm, press ${DRAW.press} mm.
   Run it as: MoveJ to aStartJoints (if bHasStart), MoveL through aPoints[1..DRAW_POINTS] with orientation
   (rRx, rRy, rRz), using rDrawSpeed where bPenDown is TRUE on this point and the previous one, rTravelSpeed otherwise,
   then MoveJ to aFinishJoints (if bHasFinish).

   1) Add Object > DUT, name ST_DrawPoint, paste the TYPE block.
   2) Add Object > Global Variable List, name GVL_Drawing, paste the rest. *)

TYPE ST_DrawPoint :
STRUCT
\tx : LREAL;        (* mm, base frame *)
\ty : LREAL;
\tz : LREAL;
\tbPenDown : BOOL;  (* TRUE = pen on the paper at this point *)
END_STRUCT
END_TYPE

{attribute 'qualified_only'}
VAR_GLOBAL CONSTANT
\tDRAW_POINTS : UINT := ${ops.length};
END_VAR
VAR_GLOBAL
\trRx : LREAL := ${f(ori[0])};   (* tool orientation, deg *)
\trRy : LREAL := ${f(ori[1])};
\trRz : LREAL := ${f(ori[2])};
\trDrawSpeed : LREAL := ${f(DRAW.drawSpeed)};     (* mm/s *)
\trTravelSpeed : LREAL := ${f(DRAW.travelSpeed)};
\tbHasStart : BOOL := ${DRAW.start ? "TRUE" : "FALSE"};
\taStartJoints : ARRAY[1..6] OF LREAL := ${joints(DRAW.start)};   (* deg *)
\tbHasFinish : BOOL := ${DRAW.finish ? "TRUE" : "FALSE"};
\taFinishJoints : ARRAY[1..6] OF LREAL := ${joints(DRAW.finish)};
\taPoints : ARRAY[1..DRAW_POINTS] OF ST_DrawPoint := [
${rows.join("\n")}
\t];
END_VAR
`;
  download(drawing.name.replace(/\.[^.]*$/, "") + "-tm262.st", st, "text/plain");
};

// ------------------------------------------------------------ sample: a star in a circle, a frame, and a spiral (uses arcs)
const SAMPLE_GCODE = (() => {
  const L = ["(sample: star in a circle)", "G21 G90", "G0 Z5"];
  const cx = 80, cy = 80, R = 60;
  L.push(`G0 X${cx + R} Y${cy}`, "G1 Z0", `G2 X${cx + R} Y${cy} I${-R} J0`, "G0 Z5");
  const star = [0, 2, 4, 1, 3, 0].map(k => { const a = Math.PI / 2 + k * 2 * Math.PI / 5; return [cx + 0.92 * R * Math.cos(a), cy + 0.92 * R * Math.sin(a)]; });
  L.push(`G0 X${star[0][0].toFixed(2)} Y${star[0][1].toFixed(2)}`, "G1 Z0");
  for (const [x, y] of star.slice(1)) L.push(`G1 X${x.toFixed(2)} Y${y.toFixed(2)}`);
  L.push("G0 Z5", "G0 X5 Y5", "G1 Z0", "G1 X155 Y5", "G1 X155 Y155", "G1 X5 Y155", "G1 X5 Y5", "G0 Z5");
  // a small spiral in the corner of the frame, from half-circle arcs
  L.push("G0 X20 Y135", "G1 Z0");
  let x = 20, r = 1.5, s = 1;
  for (let k = 0; k < 6; k++) { const nx = x + s * 2 * r; L.push(`G3 X${nx.toFixed(2)} Y135 R${r.toFixed(2)}`); x = nx; s = -s; r += 1.5; }
  L.push("G0 Z5", "M2");
  return L.join("\n");
})();

showDraw();
