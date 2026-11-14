import sys, numpy as np, trimesh
tm = trimesh.load(sys.argv[1], force="mesh")
print("watertight", tm.is_watertight, "volume %.1f cm3" % (tm.volume/1000), "bbox", np.round(tm.bounds,1).tolist())
n = tm.face_normals; c = tm.triangles_center; a = tm.area_faces
down = (n[:,2] < -np.cos(np.radians(45))) & (c[:,2] > 0.2)     # faces looking down by more than 45°, not on the bed
print("overhang area > 45°: %.0f mm²" % a[down].sum())
# group by z level / region
import collections
reg = collections.defaultdict(float)
for ci, ai in zip(c[down], a[down]):
    reg[(round(ci[2]), int(ci[0]//10*10), int(np.sign(ci[1])))] += ai
for k, v in sorted(reg.items()):
    if v > 2: print("  z %3d  x %4d..%4d  side %+d : %5.0f mm²" % (k[0], k[1], k[1]+10, k[2], v))
