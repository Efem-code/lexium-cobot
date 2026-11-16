import sys, json, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
name, scale_g, title, out = sys.argv[1], float(sys.argv[2]), sys.argv[3], sys.argv[4]
vmax = float(sys.argv[5]) if len(sys.argv) > 5 else None
d = np.load(f"surf_{name}.npz")
p, tri, vm = d["p"], d["tri"], d["vm"] * scale_g
P = p.copy(); P[2] *= -1                      # arm up, belt down
faces = P[:, tri].transpose(2, 1, 0)          # F x 3 x 3
fv = vm[tri].mean(axis=0)
vmax = vmax or np.percentile(fv, 99.5)
cmap = plt.get_cmap("turbo")
fig = plt.figure(figsize=(13, 5.6), dpi=110)
for k, (el, az) in enumerate(((22, -55), (-18, 140))):
    ax = fig.add_subplot(1, 2, k + 1, projection="3d")
    pc = Poly3DCollection(faces, facecolors=cmap(np.clip(fv / vmax, 0, 1)), edgecolor="none")
    ax.add_collection3d(pc)
    ax.set_xlim(-75, 100); ax.set_ylim(-60, 60); ax.set_zlim(-105, 5)
    ax.set_box_aspect((175, 120, 110)); ax.view_init(el, az); ax.set_axis_off()
sm = plt.cm.ScalarMappable(cmap=cmap, norm=plt.Normalize(0, vmax)); sm.set_array([])
cb = fig.colorbar(sm, ax=fig.axes, shrink=0.7, pad=0.02); cb.set_label("von Mises stress, MPa")
fig.suptitle(title, fontsize=12)
fig.savefig(out, bbox_inches="tight"); print("saved", out, "vmax", vmax)
