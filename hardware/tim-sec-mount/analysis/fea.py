"""Linear-elastic FEA of the TiM + SEC110 mount: STL -> gmsh tets -> scikit-fem P2 -> stresses per 1 g.

Usage: python fea.py <design> <stl> [mesh size mm]
Units: mm, N, MPa. Coordinates = flange frame (Z 0 = flange face, +Z away from the arm), = print Z (flange face on the bed).
"""
import json
import math
import sys

import gmsh
import numpy as np
import pyamg
from skfem import Basis, ElementTetP2, ElementVector, LinearForm, MeshTet, asm, condense
from skfem.models.elasticity import lame_parameters, linear_elasticity

TOL = 0.15
G = 9.81                      # N per kg per g
E, NU = 1800.0, 0.38          # printed PETG
RHO = 1.27e-6 * 0.8           # kg/mm^3, perimeters + infill
M_TIM, M_CAM = 0.25 + 0.10, 0.12 + 0.08   # sensor + an allowance for the cable that hangs off it
I_TIM = M_TIM / 12 * np.array([61**2 + 60**2, 86**2 + 61**2, 86**2 + 60**2])   # kg mm^2, box approximation
I_CAM = M_CAM / 12 * np.array([57.5**2 + 33.6**2, 49**2 + 33.6**2, 49**2 + 57.5**2])


def rot_y(deg):
    a = math.radians(deg)
    return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])


# ------------------------------------------------------------------ designs: where it is held, where the sensors push
def design(name):
    if name == "old":
        pt, gap, wall, clr, clen = 10, 22, 5, 0.4, 36
        cam_T, cam_tilt = np.array([62, 0, pt + 34]), 15
    elif name.startswith("new"):
        P = json.load(open("params.json"))
        pt, gap, wall, clr, clen = P["pt"], P["gap"], P["wall"], P["clr"], P["cradle_len"]
        cam_T, cam_tilt = np.array([P["cam_x"], 0, pt + P["cam_drop"]]), P["cam_tilt"]
    else:
        raise SystemExit("design?")
    back = pt + gap; front = back + 61; yin = 30 + clr; base = -62.46
    R = rot_y(-cam_tilt)

    def fixed(c, n):          # flange contact annulus (spigot Ø63 to recess Ø31.5), clamped by 4 x M6 preload
        r = np.hypot(c[0], c[1])
        return (np.abs(c[2]) < TOL) & (r > 15.75) & (r < 31.5)

    def tim(c, n):            # faces that touch the TiM: side walls, base wall / posts, lip / ledges, back pads, screw holes
        x, y, z = c
        inbox = (x > base - clr - TOL) & (x < base + clen + TOL) & (z > back - clr - TOL) & (z < front + clr + TOL)
        side = (np.abs(np.abs(y) - yin) < TOL) & inbox
        basef = (np.abs(x - (base - clr)) < TOL) & (np.abs(y) < yin + TOL) & (z > back) & (z < front + clr + TOL)
        lip = (np.abs(z - (front + clr)) < TOL) & (np.abs(y) < yin + TOL) & (x < base + clen + TOL)
        pads = (np.abs(z - (back - clr)) < TOL) & (np.abs(y) < yin + TOL) & (x > base) & (x < base + clen + TOL)
        return side | basef | lip | pads

    def cam(c, n):            # the camera's seat: the face in the camera's back plane, under the camera
        l = R.T @ (c - cam_T[:, None])
        nl = R.T @ n
        return (np.abs(l[2]) < TOL) & (np.abs(l[0]) < 24.6) & (np.abs(l[1]) < 28.9) & (nl[2] > 0.9)

    tim_com = np.array([-25.0, 0, back + 30.5])
    cam_com = cam_T + R @ np.array([0, 0, 16.8])
    optical = np.array([0, 0, back + 30.5])
    return dict(fixed=fixed, loads=[("TiM", tim, M_TIM, I_TIM, tim_com), ("SEC110", cam, M_CAM, I_CAM, cam_com)],
                optical=optical, cam_T=cam_T, R=R)


# ------------------------------------------------------------------ mesh
def mesh_stl(stl, h):
    import trimesh, pytetwild
    tm = trimesh.load(stl, force="mesh")
    bb = float(np.linalg.norm(tm.extents))
    p, t = pytetwild.tetrahedralize(np.asarray(tm.vertices, float), np.asarray(tm.faces, np.int32),
                                    edge_length_abs=h, epsilon=0.02 / bb, simplify=False, quiet=True)
    p = np.asarray(p, float); t = np.asarray(t, np.int64)
    # orient tets positively
    v = np.einsum("ij,ij->i", np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]]), p[t[:, 3]] - p[t[:, 0]])
    t[v < 0] = t[v < 0][:, [0, 2, 1, 3]]
    used = np.unique(t)
    remap = -np.ones(len(p), dtype=np.int64); remap[used] = np.arange(len(used))
    return MeshTet(p[used].T.copy(), remap[t].T.copy())


def facet_geom(m, f):
    P = m.p[:, m.facets[:, f]]                       # 3 x 3 x nf
    c = P.mean(axis=1)
    n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0], axis=0)
    a = np.linalg.norm(n, axis=0) / 2
    n = n / (2 * a)
    # outward: away from the owning element's centroid
    el = m.f2t[0, f]
    ce = m.p[:, m.t[:, el]].mean(axis=1)
    flip = np.sum(n * (c - ce), axis=0) < 0
    n[:, flip] *= -1
    return c, n, a


# ------------------------------------------------------------------ RBE3-like spreading of a rigid body's load
def spread(c, a, F, M_about_com, com):
    """Per-facet traction (force per area) so that the facets carry force F and moment M (about com) together."""
    W = a.sum(); cc = (c * a).sum(axis=1) / W
    r = c - cc[:, None]
    J = sum(a[i] * (np.dot(r[:, i], r[:, i]) * np.eye(3) - np.outer(r[:, i], r[:, i])) for i in range(len(a)))
    M = M_about_com + np.cross(com - cc, F)          # moment about the facets' centroid
    k = np.linalg.solve(J, M)
    return (F[:, None] / W + np.cross(k[:, None], r, axis=0))


def run(name, stl, h=2.5):
    D = design(name)
    m = mesh_stl(stl, h)
    e = ElementVector(ElementTetP2())
    ib = Basis(m, e, intorder=2)
    lam, mu = lame_parameters(E, NU)
    K = asm(linear_elasticity(lam, mu), ib)
    vol = float(np.sum(ib.dx))
    print(f"{name}: {m.t.shape[1]} tets, {K.shape[0]} dofs, volume {vol/1000:.1f} cm³, mass {vol*RHO*1000:.0f} g")

    bf = m.boundary_facets()
    c, n, a = facet_geom(m, bf)
    fixf = bf[D["fixed"](c, n)]
    D_dofs = ib.get_dofs(fixf).all()
    groups = []
    for (lbl, sel, mass, I, com) in D["loads"]:
        s = sel(c, n)
        print(f"  {lbl}: {s.sum()} facets, {a[s].sum():.0f} mm² carry its load")
        groups.append((lbl, bf[s], c[:, s], a[s], mass, I, com))
    print(f"  fixed: {len(fixf)} facets, {a[np.isin(bf, fixf)].sum():.0f} mm²")

    # one assembly per facet group: nodal load vector from a per-facet constant traction
    from skfem import FacetBasis
    def traction_vec(facets, trac):
        fb = FacetBasis(m, e, facets=facets, intorder=2)
        tq = np.repeat(trac[:, :, None], fb.X.shape[-1] if fb.X.ndim == 3 else 1, axis=2)
        @LinearForm
        def lf(v, w):
            return sum(w.t[i] * v[i] for i in range(3))
        return asm(lf, fb, t=tq)

    def body_vec(fun):
        @LinearForm
        def lf(v, w):
            g = fun(w.x)
            return sum(g[i] * v[i] for i in range(3))
        return asm(lf, ib)

    def case_load(acc=None, alpha=None):
        """acc: inertial load direction in g (body force per mass = acc*G); alpha: angular acceleration rad/s² about the flange origin."""
        f = np.zeros(K.shape[0])
        for (lbl, fac, cf, af, mass, I, com) in groups:
            if acc is not None:
                F = mass * G * np.asarray(acc, float); Mc = np.zeros(3)
            else:
                al = np.asarray(alpha, float)
                F = -mass * np.cross(al, com) * 1e-3          # kg * mm/s² -> N
                Mc = -(I * al) * 1e-3                         # kg mm² /s² = N mm * 1e-3
            f += traction_vec(fac, spread(cf, af, F, Mc, com))
        if acc is not None:
            f += body_vec(lambda x: RHO * G * np.asarray(acc, float)[:, None, None] * np.ones_like(x[0])[None])
        else:
            al = np.asarray(alpha, float)
            f += body_vec(lambda x: -RHO * 1e-3 * np.stack([al[1] * x[2] - al[2] * x[1], al[2] * x[0] - al[0] * x[2], al[0] * x[1] - al[1] * x[0]]))
        return f

    # AMG with rigid-body modes
    I_free = ib.complement_dofs(D_dofs)
    A = K[I_free][:, I_free].tocsr()
    X = ib.doflocs[:, I_free]
    comp = np.zeros(len(I_free), dtype=int)
    nd = ib.nodal_dofs
    # component of each dof: doflocs alone doesn't say it; use the vector element's dof ordering (x, y, z interleaved)
    comp_all = np.zeros(K.shape[0], dtype=int)
    for k in range(3):
        comp_all[ib.nodal_dofs[k]] = k
        if hasattr(ib, "facet_dofs") and ib.facet_dofs.size:
            comp_all[ib.facet_dofs[k]] = k
        if ib.edge_dofs.size:
            comp_all[ib.edge_dofs[k]] = k
    comp = comp_all[I_free]
    B = np.zeros((len(I_free), 6))
    for k in range(3):
        B[comp == k, k] = 1
    x, y, z = X
    B[comp == 0, 3] = -y[comp == 0]; B[comp == 1, 3] = x[comp == 1]
    B[comp == 1, 4] = -z[comp == 1]; B[comp == 2, 4] = y[comp == 2]
    B[comp == 0, 5] = z[comp == 0]; B[comp == 2, 5] = -x[comp == 2]
    ml = pyamg.smoothed_aggregation_solver(A, B=B, max_coarse=2000)

    def solve(f):
        u = np.zeros(K.shape[0])
        res = []
        u[I_free] = ml.solve(f[I_free], tol=1e-9, accel="cg", maxiter=400, residuals=res)
        return u

    # stresses per element (max over its quadrature points)
    def stresses(u):
        w = ib.interpolate(u)
        gu = w.grad                                       # 3 x 3 x nel x nq
        eps = 0.5 * (gu + np.transpose(gu, (1, 0, 2, 3)))
        tr = eps[0, 0] + eps[1, 1] + eps[2, 2]
        s = 2 * mu * eps
        for i in range(3):
            s[i, i] += lam * tr
        vm = np.sqrt(0.5 * ((s[0, 0] - s[1, 1])**2 + (s[1, 1] - s[2, 2])**2 + (s[2, 2] - s[0, 0])**2) + 3 * (s[0, 1]**2 + s[1, 2]**2 + s[0, 2]**2))
        return dict(vm=vm, szz=s[2, 2], tz=np.hypot(s[0, 2], s[1, 2]))

    # elements touching the clamp or a load face carry modelling peaks (point loads, rigid clamp): reported apart
    near = np.zeros(m.t.shape[1], bool)
    special = np.concatenate([fixf] + [g[1] for g in groups])
    near[m.f2t[0, special]] = True
    # and their neighbours
    nodes = np.unique(m.t[:, near])
    near = np.isin(m.t, nodes).any(axis=0)

    def sensor_motion(u):
        out = {}
        for (lbl, fac, cf, af, mass, I, com) in groups:
            fb_nodes = m.facets[:, fac]
            # facet displacement = mean of its vertex displacements (P2 vertex dofs = nodal dofs)
            uv = np.stack([u[ib.nodal_dofs[k]] for k in range(3)])     # 3 x nverts
            uf = uv[:, fb_nodes].mean(axis=1)
            W = af.sum(); cc = (cf * af).sum(axis=1) / W; r = cf - cc[:, None]
            t = (uf * af).sum(axis=1) / W
            J = sum(af[i] * (np.dot(r[:, i], r[:, i]) * np.eye(3) - np.outer(r[:, i], r[:, i])) for i in range(len(af)))
            th = np.linalg.solve(J, (np.cross(r, uf - t[:, None], axis=0) * af).sum(axis=1))
            ucom = t + np.cross(th, com - cc)
            out[lbl] = dict(u=ucom, theta=th)
        return out

    cases = {}
    for lbl, acc in (("X", [1, 0, 0]), ("Y", [0, 1, 0]), ("Z", [0, 0, 1])):
        cases["1g " + lbl] = case_load(acc=acc)
    for lbl, al in (("X", [100, 0, 0]), ("Y", [0, 100, 0]), ("Z", [0, 0, 100])):
        cases["100 rad/s² about " + lbl] = case_load(alpha=al)

    out = {"design": name, "mesh": int(m.t.shape[1]), "dofs": int(K.shape[0]), "volume_cm3": vol / 1000, "cases": {}}
    U = {}
    for k, f in cases.items():
        u = solve(f)
        U[k] = u
        S = stresses(u)
        el_vm = S["vm"].max(axis=1); el_sz = np.abs(S["szz"]).max(axis=1); el_tz = S["tz"].max(axis=1)
        mot = sensor_motion(u)
        umag = np.sqrt(sum(u[ib.nodal_dofs[i]]**2 for i in range(3)))
        r = {"vm_max": float(el_vm[~near].max()), "vm_max_incl_bc": float(el_vm.max()),
             "szz_max": float(el_sz[~near].max()), "tz_max": float(el_tz[~near].max()),
             "vm_p999": float(np.percentile(el_vm[~near], 99.9)),
             "u_max": float(umag.max()),
             "motion": {s: {"u_mm": [float(v) for v in d["u"]], "theta_deg": [float(math.degrees(v)) for v in d["theta"]]} for s, d in mot.items()}}
        # where is the peak?
        i = int(np.argmax(np.where(near, -1, el_vm)))
        r["vm_at"] = [round(float(v), 1) for v in m.p[:, m.t[:, i]].mean(axis=1)]
        j = int(np.argmax(np.where(near, -1, el_sz)))
        r["szz_at"] = [round(float(v), 1) for v in m.p[:, m.t[:, j]].mean(axis=1)]
        out["cases"][k] = r
        print(f"  {k:22s} VM {r['vm_max']:6.3f} MPa (p99.9 {r['vm_p999']:.3f}) at {r['vm_at']}  |σz| {r['szz_max']:.3f} at {r['szz_at']}  τz {r['tz_max']:.3f}"
              f"  umax {r['u_max']*1000:.1f} µm  TiM {np.linalg.norm(mot['TiM']['u'])*1000:.1f} µm {np.degrees(np.linalg.norm(mot['TiM']['theta'])):.4f}°"
              f"  cam {np.linalg.norm(mot['SEC110']['u'])*1000:.1f} µm")

    # worst direction per g, from the three unit cases (linear: any direction n gives sum n_i * u_i)
    # sample directions on a sphere and combine the fields
    W = {k: stresses(U[k]) for k in ("1g X", "1g Y", "1g Z")}
    best = dict(vm=0, sz=0, tz=0, fi=0, dir_vm=None, dir_fi=None)
    rng = np.random.default_rng(1)
    dirs = rng.normal(size=(400, 3)); dirs /= np.linalg.norm(dirs, axis=1)[:, None]
    dirs = np.vstack([dirs, np.eye(3), -np.eye(3)])
    vm_el = {}
    for d in dirs:
        u = d[0] * U["1g X"] + d[1] * U["1g Y"] + d[2] * U["1g Z"]
        S = stresses(u)
        vm = S["vm"].max(axis=1)[~near].max()
        sz = np.clip(S["szz"], 0, None).max(axis=1)[~near].max()
        # interlayer: tension across layers + shear along them (quadratic interaction), per g
        fi = np.sqrt((np.clip(S["szz"], 0, None) / 15.0)**2 + (S["tz"] / 15.0)**2).max(axis=1)[~near].max()
        if vm > best["vm"]:
            best.update(vm=float(vm), dir_vm=[round(float(v), 2) for v in d])
        if fi > best["fi"]:
            best.update(fi=float(fi), sz=float(sz), dir_fi=[round(float(v), 2) for v in d])
    out["worst_per_g"] = best
    # static deflection of each sensor in its worst direction -> lowest natural frequency estimate (Rayleigh)
    freq = {}
    for (lbl, *_rest) in groups:
        dmax = 0
        for d in np.vstack([np.eye(3)]):
            pass
    defl = {}
    for k in ("1g X", "1g Y", "1g Z"):
        mot = out["cases"][k]["motion"]
        defl[k] = {s: float(np.linalg.norm(v["u_mm"])) for s, v in mot.items()}
    out["defl_1g_mm"] = defl
    for k in ("1g X", "1g Y", "1g Z"):
        num = sum(mm * defl[k][s] for s, mm in (("TiM", M_TIM), ("SEC110", M_CAM)))
        den = sum(mm * defl[k][s]**2 for s, mm in (("TiM", M_TIM), ("SEC110", M_CAM)))
        freq[k] = float(math.sqrt(9810 * num / den) / (2 * math.pi)) if den > 0 else None
    out["f_est_hz"] = freq
    print("  worst per g:", best)
    print("  natural frequency estimate (Hz):", {k: round(v, 0) for k, v in freq.items()})
    json.dump(out, open(f"res_{name}.json", "w"), indent=1)

    # save surface stress for pictures: boundary triangles + nodal VM for the worst VM direction
    d = np.array(best["dir_vm"])
    u = d[0] * U["1g X"] + d[1] * U["1g Y"] + d[2] * U["1g Z"]
    S = stresses(u)
    el = S["vm"].max(axis=1)
    nv = np.zeros(m.p.shape[1]); cnt = np.zeros(m.p.shape[1])
    for k in range(4):
        np.maximum.at(nv, m.t[k], el)
    np.savez(f"surf_{name}.npz", p=m.p, tri=m.facets[:, bf], vm=nv, dir=d)
    return out


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 2.5)
