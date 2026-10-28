// In-browser Lexium Cobot simulator (demo mode). JavaScript port of
// cobot/kinematics.py + cobot/sim_robot.py + the JSON command handler, so the
// app runs on a phone with no PC. It answers the same /api/* calls as the
// Python bridge (see LocalTransport at the bottom).
"use strict";
(function (global) {
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

const PROFILES = {
  // modified DH (JAKA convention); L03 read from a real controller via get_dh_param
  LXMRL03: {name: "Lexium Cobot L03 (3 kg)", d1: 150.255, a2: 246.914, a3: 227.688, d4: 113.122, d5: 118.09, d6: 105.926, reach: 626, payload: 3, vmax: 180},
  LXMRL07: {name: "Lexium Cobot L07 (7 kg)", d1: 120.15, a2: 360.0, a3: 303.5, d4: 113.5, d5: 113.5, d6: 107.0, reach: 819, payload: 7, vmax: 180},
  LXMRL12: {name: "Lexium Cobot L12 (12 kg)", d1: 142.65, a2: 595.0, a3: 571.5, d4: 131.5, d5: 115.5, d6: 105.5, reach: 1327, payload: 12, vmax: 120},
  LXMRL18: {name: "Lexium Cobot L18 (18 kg)", d1: 166.0, a2: 476.0, a3: 420.0, d4: 160.0, d5: 129.0, d6: 118.0, reach: 1073, payload: 18, vmax: 120},
};
const JOINT_LIMITS = [[-360, 360], [-85, 265], [-175, 175], [-85, 265], [-360, 360], [-360, 360]];
const ALPHA = [0, 90, 0, 0, 90, -90];
const HOME = [0, 90, -90, 90, 90, 0];

// ------------------------------------------------------------ matrices
function matMul(A, B) {
  const n = A.length, m = B.length, p = B[0].length, C = [];
  for (let i = 0; i < n; i++) { const r = new Array(p).fill(0); for (let k = 0; k < m; k++) { const a = A[i][k]; if (a) for (let j = 0; j < p; j++) r[j] += a * B[k][j]; } C.push(r); }
  return C;
}
const transpose = A => A[0].map((_, j) => A.map(r => r[j]));
function mdh(al, a, t, d) {
  const ct = Math.cos(t), st = Math.sin(t), ca = Math.cos(al), sa = Math.sin(al);
  return [[ct, -st, 0, a], [st * ca, ct * ca, -sa, -sa * d], [st * sa, ct * sa, ca, ca * d], [0, 0, 0, 1]];
}
function rpyToR(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [[cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx], [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx], [-sy, cy * sx, cy * cx]];
}
function RToRpy(R) {
  const sy = -R[2][0];
  if (Math.abs(sy) < 0.999999) return [Math.atan2(R[2][1], R[2][2]), Math.asin(sy), Math.atan2(R[1][0], R[0][0])];
  return [Math.atan2(-R[1][2], R[1][1]), Math.sign(sy) * Math.PI / 2, 0];
}
function rotToAxisAngle(R) {
  const c = Math.max(-1, Math.min(1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2)), ang = Math.acos(c);
  if (ang < 1e-9) return [0, 0, 0];
  if (Math.abs(Math.PI - ang) < 1e-4) {
    const x = Math.sqrt(Math.max(0, (R[0][0] + 1) / 2));
    const y = Math.sign(R[0][1] || 1) * Math.sqrt(Math.max(0, (R[1][1] + 1) / 2));
    const z = Math.sign(R[0][2] || 1) * Math.sqrt(Math.max(0, (R[2][2] + 1) / 2));
    return [x * ang, y * ang, z * ang];
  }
  const s = 2 * Math.sin(ang);
  return [(R[2][1] - R[1][2]) / s * ang, (R[0][2] - R[2][0]) / s * ang, (R[1][0] - R[0][1]) / s * ang];
}
function axisAngleToR(v) {
  const ang = Math.hypot(v[0], v[1], v[2]);
  if (ang < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = v.map(c => c / ang), c = Math.cos(ang), s = Math.sin(ang), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
function solve(A, b) {
  const n = A.length, M = A.map((r, i) => [...r, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error("singular");
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) if (r !== col) { const f = M[r][col] / M[col][col]; if (f) for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
const withinLimits = q => q.every((v, i) => v >= JOINT_LIMITS[i][0] - 1e-6 && v <= JOINT_LIMITS[i][1] + 1e-6);

// ------------------------------------------------------------ arm
class Arm {
  constructor(model = "LXMRL03") { this.setModel(model); }
  setModel(model) {
    if (!PROFILES[model]) throw new Error("unknown model " + model);
    const p = PROFILES[model];
    this.model = model; this.profile = p;
    this.d = [p.d1, 0, 0, -p.d4, p.d5, p.d6];
    this.a = [0, 0, p.a2, p.a3, 0, 0];
    this.alpha = ALPHA.map(x => x * D2R);
    this.tool = this.tool || [0, 0, 0, 0, 0, 0];
  }
  frames(q) {
    let T = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    const out = [T];
    for (let i = 0; i < 6; i++) { T = matMul(T, mdh(this.alpha[i], this.a[i], q[i] * D2R, this.d[i])); out.push(T); }
    const [tx, ty, tz, rx, ry, rz] = this.tool, Rt = rpyToR(rx * D2R, ry * D2R, rz * D2R);
    out.push(matMul(T, [[...Rt[0], tx], [...Rt[1], ty], [...Rt[2], tz], [0, 0, 0, 1]]));
    return out;
  }
  fkT(q) { return this.frames(q)[7]; }
  fk(q) {
    const T = this.fkT(q), [rx, ry, rz] = RToRpy(T.slice(0, 3).map(r => r.slice(0, 3)));
    return [T[0][3], T[1][3], T[2][3], rx * R2D, ry * R2D, rz * R2D];
  }
  jointPoints(q) {
    const F = this.frames(q), pts = [[0, 0, 0]];
    for (let i = 0; i < 6; i++) {
      const T = F[i], a = this.a[i];
      pts.push([T[0][3] + T[0][0] * a, T[1][3] + T[1][0] * a, T[2][3] + T[2][0] * a]);
      pts.push([F[i + 1][0][3], F[i + 1][1][3], F[i + 1][2][3]]);
    }
    const T = F[7]; pts.push([T[0][3], T[1][3], T[2][3]]);
    return pts;
  }
  poseErr(T, Tt) {
    const R = T.slice(0, 3).map(r => r.slice(0, 3)), Rt = Tt.slice(0, 3).map(r => r.slice(0, 3));
    return [Tt[0][3] - T[0][3], Tt[1][3] - T[1][3], Tt[2][3] - T[2][3], ...rotToAxisAngle(matMul(Rt, transpose(R)))];
  }
  jacobian(q, eps = 1e-4) {
    const T0 = this.fkT(q), J = [0, 1, 2, 3, 4, 5].map(() => new Array(6).fill(0));
    for (let j = 0; j < 6; j++) {
      const qq = q.slice(); qq[j] += eps * R2D;
      const e = this.poseErr(T0, this.fkT(qq));
      for (let i = 0; i < 6; i++) J[i][j] = e[i] / eps;
    }
    return J;
  }
  poseToT(p) { const R = rpyToR(p[3] * D2R, p[4] * D2R, p[5] * D2R); return [[...R[0], p[0]], [...R[1], p[1]], [...R[2], p[2]], [0, 0, 0, 1]]; }
  ik(pose, seed, iters = 120) {
    const Tt = this.poseToT(pose), w = 300, lam = 5;
    let q = seed.slice();
    for (let it = 0; it < iters; it++) {
      const e = this.poseErr(this.fkT(q), Tt);
      if (Math.hypot(e[0], e[1], e[2]) < 0.05 && Math.hypot(e[3], e[4], e[5]) < 1e-4) return wrapToSeed(q, seed);
      const ew = [e[0], e[1], e[2], e[3] * w, e[4] * w, e[5] * w];
      const J = this.jacobian(q), Jw = [J[0], J[1], J[2], J[3].map(x => x * w), J[4].map(x => x * w), J[5].map(x => x * w)];
      const JT = transpose(Jw), A = matMul(Jw, JT);
      for (let i = 0; i < 6; i++) A[i][i] += lam * lam;
      let y; try { y = solve(A, ew); } catch (_) { break; }
      let dq = JT.map(r => r.reduce((s, v, k) => s + v * y[k], 0));
      const m = Math.max(...dq.map(Math.abs));
      if (m > 0.2) dq = dq.map(x => x * 0.2 / m);
      q = q.map((v, i) => v + dq[i] * R2D);
    }
    throw new Error("IK did not converge (target unreachable or singular)");
  }
}
function wrapToSeed(q, seed) { return q.map((a, i) => { while (a - seed[i] > 180) a -= 360; while (a - seed[i] < -180) a += 360; return a; }); }

// ------------------------------------------------------------ motion profile
class Trapezoid {
  constructor(D, vmax, amax) {
    this.D = D; vmax = Math.max(vmax, 1e-6); amax = Math.max(amax, 1e-6);
    let ta = vmax / amax, da = 0.5 * amax * ta * ta;
    if (2 * da > D) { ta = Math.sqrt(D / amax); vmax = amax * ta; da = D / 2; }
    this.v = vmax; this.a = amax; this.ta = ta; this.tc = (D - 2 * da) / vmax; this.T = 2 * ta + this.tc;
  }
  s(t) {
    if (this.D <= 0 || t >= this.T) return 1;
    let d;
    if (t < this.ta) d = 0.5 * this.a * t * t;
    else if (t < this.ta + this.tc) d = 0.5 * this.a * this.ta ** 2 + this.v * (t - this.ta);
    else { const tr = this.T - t; d = this.D - 0.5 * this.a * tr * tr; }
    return d / this.D;
  }
}

// ------------------------------------------------------------ virtual robot
class SimRobot {
  constructor(model = "LXMRL03") {
    this.arm = new Arm(model);
    this.q = HOME.slice(); this.qd = [0, 0, 0, 0, 0, 0];
    this.tcp = this.arm.fk(this.q); this.tcpSpeed = [0, 0, 0, 0, 0, 0];
    this.powered = false; this.enabled = false; this.estop = false; this.protectiveStop = false; this.onSoftLimit = false;
    this.controlSource = "remote"; this.rapidRate = 1; this.errcode = 0; this.errmsg = "";
    this.din = new Array(128).fill(0); this.dout = new Array(128).fill(0);
    this.motion = null; this.jog = null; this.log = [];
    this.jointTemp = [30, 30, 30, 30, 30, 30]; this.cabTemp = 32;
  }
  event(m) { this.log.push(m); if (this.log.length > 50) this.log.shift(); }
  fault(code, msg) { this.errcode = code; this.errmsg = msg; this.motion = this.jog = null; this.event(`ERROR ${code}: ${msg}`); }
  ready() {
    if (this.estop) return "emergency stop active";
    if (!this.powered) return "robot not powered on";
    if (!this.enabled) return "robot not enabled";
    if (this.protectiveStop) return "protective stop active - clear error first";
    if (this.errcode) return `error ${this.errcode} active - clear error first`;
    if (this.controlSource !== "remote") return "control source is not Remote";
    return null;
  }
  powerOn() { if (this.estop) return "emergency stop active"; this.powered = true; this.event("power on"); }
  powerOff() { this.powered = this.enabled = false; this.motion = this.jog = null; this.event("power off"); }
  enable() { if (this.estop) return "emergency stop active"; if (!this.powered) return "robot not powered on"; this.enabled = true; this.event("robot enabled"); }
  disable() { this.enabled = false; this.motion = this.jog = null; this.event("robot disabled"); }
  setEstop(on) { this.estop = !!on; if (on) { this.enabled = this.powered = false; this.motion = this.jog = null; this.event("EMERGENCY STOP pressed"); } else this.event("emergency stop released"); }
  setProtectiveStop() { this.protectiveStop = true; this.motion = this.jog = null; this.event("protective stop (simulated collision)"); }
  clearError() { this.errcode = 0; this.errmsg = ""; this.protectiveStop = false; this.onSoftLimit = false; this.event("errors cleared"); }
  stop() { this.motion = this.jog = null; }
  jogJoint(j, vel) { if (!vel) { this.jog = null; return; } const e = this.ready(); if (e) return e; this.motion = null; this.jog = {kind: "joint", axis: j, vel}; }
  jogCart(axis, vel, frame) { if (!vel) { this.jog = null; return; } const e = this.ready(); if (e) return e; this.motion = null; this.jog = {kind: "cart", axis, vel, frame}; }
  moveJoint(target, speed = 30, accel = 100, rel = false) {
    const e = this.ready(); if (e) return e;
    const tgt = rel ? this.q.map((v, i) => v + target[i]) : target.map(Number);
    if (!withinLimits(tgt)) return "target outside joint limits";
    const D = Math.max(...tgt.map((v, i) => Math.abs(v - this.q[i])));
    this.jog = null;
    this.motion = {kind: "joint", start: this.q.slice(), target: tgt, prof: new Trapezoid(D, Math.min(speed, this.arm.profile.vmax), accel), t: 0};
    this.event("MoveJ -> " + JSON.stringify(tgt.map(v => +v.toFixed(1))));
  }
  movePoseJoint(pose, speed, accel) { let q; try { q = this.arm.ik(pose, this.q); } catch (err) { return err.message; } return this.moveJoint(q, speed, accel); }
  moveLinear(pose, speed = 100, accel = 500, rel = false) {
    const e = this.ready(); if (e) return e;
    const start = this.tcp.slice(), tgt = rel ? start.map((v, i) => v + pose[i]) : pose.map(Number);
    const R0 = this.arm.poseToT(start).slice(0, 3).map(r => r.slice(0, 3)), R1 = this.arm.poseToT(tgt).slice(0, 3).map(r => r.slice(0, 3));
    const rotvec = rotToAxisAngle(matMul(R1, transpose(R0)));
    const lin = Math.hypot(tgt[0] - start[0], tgt[1] - start[1], tgt[2] - start[2]);
    const ang = Math.hypot(...rotvec) * R2D;
    try { this.arm.ik(tgt, this.q); } catch (err) { return err.message; }
    this.jog = null;
    this.motion = {kind: "linear", p0: start.slice(0, 3), p1: tgt.slice(0, 3), R0, rotvec, prof: new Trapezoid(Math.max(lin, ang * 2), speed, accel), t: 0};
    this.event("MoveL -> " + JSON.stringify(tgt.map(v => +v.toFixed(1))));
  }
  step(dt) {
    const prevQ = this.q.slice(), prevTcp = this.tcp.slice();
    if (this.motion) this.stepMotion(dt * this.rapidRate);
    else if (this.jog) this.stepJog(dt);
    for (let i = 0; i < 6; i++) {
      const [lo, hi] = JOINT_LIMITS[i];
      if (this.q[i] < lo || this.q[i] > hi) { this.q[i] = Math.min(hi, Math.max(lo, this.q[i])); this.onSoftLimit = true; this.motion = this.jog = null; this.event(`J${i + 1} reached soft limit`); }
    }
    this.tcp = this.arm.fk(this.q);
    this.qd = this.q.map((v, i) => (v - prevQ[i]) / dt);
    this.tcpSpeed = this.tcp.map((v, i) => i < 3 ? (v - prevTcp[i]) / dt : (((v - prevTcp[i] + 180) % 360 + 360) % 360 - 180) / dt);
    for (let i = 0; i < 6; i++) this.jointTemp[i] += (30 + (this.enabled ? 8 : 0) + Math.abs(this.qd[i]) * 0.05 - this.jointTemp[i]) * 0.0005;
    this.cabTemp += ((this.powered ? 35 : 30) - this.cabTemp) * 0.0005;
  }
  stepMotion(dt) {
    const m = this.motion; m.t += dt; const s = m.prof.s(m.t);
    if (m.kind === "joint") this.q = m.start.map((v, i) => v + (m.target[i] - v) * s);
    else {
      const p = m.p0.map((v, i) => v + (m.p1[i] - v) * s);
      const [rx, ry, rz] = RToRpy(matMul(axisAngleToR(m.rotvec.map(v => v * s)), m.R0));
      let q;
      try { q = this.arm.ik([...p, rx * R2D, ry * R2D, rz * R2D], this.q, 30); } catch (_) { this.fault(1101, "MoveL path not reachable (singularity)"); return; }
      if (Math.max(...q.map((v, i) => Math.abs(v - this.q[i]))) / dt > 400) { this.fault(1102, "MoveL joint speed too high near singularity"); return; }
      this.q = q;
    }
    if (s >= 1) { this.motion = null; this.event("motion done (in position)"); }
  }
  stepJog(dt) {
    const j = this.jog, vmax = this.arm.profile.vmax;
    if (j.kind === "joint") { this.q[j.axis] += Math.max(-vmax, Math.min(vmax, j.vel)) * this.rapidRate * dt; return; }
    let tw = [0, 0, 0, 0, 0, 0]; const vel = j.vel * this.rapidRate;
    tw[j.axis] = j.axis < 3 ? vel : vel * D2R;
    if (j.frame === "tool") {
      const T = this.arm.fkT(this.q), R = T.slice(0, 3).map(r => r.slice(0, 3));
      const rot = v => R.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
      tw = [...rot(tw.slice(0, 3)), ...rot(tw.slice(3))];
    }
    const J = this.arm.jacobian(this.q), JT = transpose(J), A = matMul(J, JT);
    for (let i = 0; i < 6; i++) A[i][i] += 1;
    let y; try { y = solve(A, tw); } catch (_) { this.jog = null; return; }
    const qdot = JT.map(r => r.reduce((s, v, k) => s + v * y[k], 0) * R2D);
    if (Math.max(...qdot.map(Math.abs)) > vmax) { this.fault(1103, "Cartesian jog near singularity - jog joints instead"); return; }
    this.q = this.q.map((v, i) => v + qdot[i] * dt);
  }
  // JSON command handler (same names as the real controller protocol)
  command(msg) {
    const cmd = msg.cmdName || "", ok = (x = {}) => Object.assign({errorCode: "0", errorMsg: "", cmdName: cmd}, x);
    let e;
    try {
      switch (cmd) {
        case "power_on": e = this.powerOn(); break;
        case "power_off": e = this.powerOff(); break;
        case "enable_robot": e = this.enable(); break;
        case "disable_robot": e = this.disable(); break;
        case "stop_program": e = this.stop(); break;
        case "clear_error": e = this.clearError(); break;
        case "set_rapidrate": this.rapidRate = Math.max(0.01, Math.min(1, +msg.rapid_rate)); break;
        case "joint_move": e = this.moveJoint(msg.jointPosition, +(msg.speed ?? 20), +(msg.accel ?? 100), !!msg.relFlag); break;
        case "end_move": e = this.movePoseJoint(msg.endPosition, +(msg.speed ?? 20), +(msg.accel ?? 100)); break;
        case "moveL": e = this.moveLinear(msg.cartPosition, +(msg.speed ?? 50), +(msg.accel ?? 500), !!msg.relFlag); break;
        case "jog": {
          const mode = +(msg.jog_mode || 0), coord = ({0: "base", 1: "joint", 2: "tool"})[+(msg.coord_map ?? 1)], axis = +(msg.jnum || 1) - 1, vel = +(msg.jogvel || 0);
          if (mode === 0) e = this.stop();
          else if (coord === "joint") e = this.jogJoint(axis, vel);
          else e = this.jogCart(axis, vel, coord);
          break;
        }
        case "set_digital_output": this.dout[+msg.index] = +msg.value ? 1 : 0; break;
        case "set_tool_offsets": this.arm.tool = msg.tooloffset.map(Number); break;
        case "sim_estop": e = this.setEstop(msg.on !== false); break;
        case "sim_protective_stop": e = this.setProtectiveStop(); break;
        case "sim_control_source": this.controlSource = msg.source === "remote" ? "remote" : "local"; this.event("control source -> " + this.controlSource); break;
        case "sim_set_model": this.motion = this.jog = null; this.arm.setModel(msg.model); this.event("model -> " + msg.model); break;
        case "sim_set_din": this.din[+msg.index] = +msg.value ? 1 : 0; break;
        default: return {errorCode: "1", errorMsg: `unknown command '${cmd}'`, cmdName: cmd};
      }
    } catch (err) { return {errorCode: "1", errorMsg: "bad parameters: " + err.message, cmdName: cmd}; }
    return e ? {errorCode: "2", errorMsg: e, cmdName: cmd} : ok();
  }
}

// ------------------------------------------------------------ transport (fake /api)
class LocalTransport {
  constructor() {
    let model = "LXMRL03";
    try { model = localStorage.getItem("demoModel") || model; } catch (_) {}
    this.robot = new SimRobot(PROFILES[model] ? model : "LXMRL03");
    this.jogActive = false; this.jogLast = 0; this.lastError = "";
    let last = performance.now(), acc = 0;
    setInterval(() => {
      const now = performance.now(); acc += Math.min(0.1, (now - last) / 1000); last = now;
      while (acc >= 0.01) { this.robot.step(0.01); acc -= 0.01; }
      if (this.jogActive && now - this.jogLast > 350) { this.jogActive = false; this.robot.stop(); }   // dead-man watchdog
    }, 10);
  }
  cmd(name, f = {}) {
    const r = this.robot.command(Object.assign({cmdName: name}, f));
    if (r.errorCode !== "0") this.lastError = `${name}: ${r.errorMsg}`;
    return r;
  }
  status() {
    const r = this.robot, on = r.enabled;
    return {
      connected: true, mode: "demo", host: "this device", ports: {}, modbus_ok: true, cmd_ok: true, stream_ok: true,
      motion_armed: true, last_error: this.lastError, jogging: this.jogActive && !!r.jog, model: r.arm.model, model_name: r.arm.profile.name,
      joints: r.q.slice(), joint_speed: r.qd.slice(), tcp: r.tcp.slice(), tcp_speed: r.tcpSpeed.slice(),
      joint_current: r.qd.map(v => on ? 0.6 + Math.abs(v) * 0.01 + (Math.random() - 0.5) * 0.04 : 0),
      joint_temp: r.jointTemp.map(Math.round), joint_voltage: r.q.map(() => r.powered ? 48 : 0),
      powered: r.powered, enabled: on, estop: r.estop, protective_stop: r.protectiveStop, on_soft_limit: r.onSoftLimit,
      inpos: !r.motion && !r.jog, motion_mode: r.motion ? "servo position" : "jog/other", speed_ratio: r.rapidRate * 100,
      errcode: r.errcode, errmsg: r.errmsg, cab_temp: r.cabTemp, cab_power: on ? 120 : 25,
      dout: r.dout.slice(0, 16), din: r.din.slice(0, 16), points: r.arm.jointPoints(r.q),
      control_source: r.controlSource, log: r.log.slice(-10),
    };
  }
  async call(path, b = {}) {
    try {
      switch (path) {
        case "/api/auth": return {need_pin: false, ok: true};
        case "/api/models": return {profiles: PROFILES, limits: JOINT_LIMITS, home: HOME};
        case "/api/state": return this.status();
        case "/api/connect": case "/api/disconnect": case "/api/arm": return {ok: true};
        case "/api/cmd": { const {cmdName, ...rest} = b; return this.cmd(cmdName, rest); }
        case "/api/jog": {
          const cm = {base: 0, joint: 1, tool: 2}[b.coord];
          const r = this.cmd("jog", {jog_mode: 2, coord_map: cm, jnum: +b.axis + 1, jogvel: +b.speed * (b.dir > 0 ? 1 : -1)});
          if (r.errorCode === "0") { this.jogActive = true; this.jogLast = performance.now(); }
          return r;
        }
        case "/api/jog/keepalive": this.jogLast = performance.now(); return {jogging: this.jogActive};
        case "/api/jog/stop": this.jogActive = false; return this.cmd("jog", {jog_mode: 0});
        case "/api/stop": this.jogActive = false; return this.cmd("stop_program");
        case "/api/ik": { const q = this.robot.arm.ik(b.pose, b.seed || this.robot.q); return {joints: q, ok: withinLimits(q), points: this.robot.arm.jointPoints(q)}; }
        case "/api/fk": return {tcp: this.robot.arm.fk(b.joints), points: this.robot.arm.jointPoints(b.joints)};
        case "/api/model": try { localStorage.setItem("demoModel", b.model); } catch (_) {} return this.cmd("sim_set_model", {model: b.model});
      }
      return {errorCode: "404", errorMsg: "unknown " + path};
    } catch (err) { return {errorCode: "500", errorMsg: err.message}; }
  }
  subscribe(cb) { setInterval(() => cb(this.status()), 50); }
}

global.CobotSim = {Arm, SimRobot, LocalTransport, PROFILES, JOINT_LIMITS, HOME};
})(window);
