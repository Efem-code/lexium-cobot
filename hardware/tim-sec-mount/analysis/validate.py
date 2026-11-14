# Cantilever 10 x 10 x 100 mm, fixed at x=0, 10 N down at the tip face: delta = F L^3 / (3 E I), sigma = F L c / I
import numpy as np, trimesh, time
import fea
from skfem import Basis, FacetBasis, ElementTetP2, ElementVector, LinearForm, asm, condense, solve
from skfem.models.elasticity import lame_parameters, linear_elasticity
box = trimesh.creation.box(extents=[100, 10, 10]); box.apply_translation([50, 0, 0]); box.export("beam.stl")
m = fea.mesh_stl("beam.stl", 2.5)
e = ElementVector(ElementTetP2()); ib = Basis(m, e, intorder=2)
lam, mu = lame_parameters(fea.E, fea.NU)
K = asm(linear_elasticity(lam, mu), ib)
bf = m.boundary_facets(); c, n, a = fea.facet_geom(m, bf)
fix = bf[np.abs(c[0]) < 0.1]; tip = bf[np.abs(c[0] - 100) < 0.1]
fb = FacetBasis(m, e, facets=tip, intorder=2)
A = a[np.abs(c[0] - 100) < 0.1].sum()
@LinearForm
def lf(v, w): return -10.0 / A * v[2]
f = asm(lf, fb)
u = solve(*condense(K, f, D=ib.get_dofs(fix).all()))
uz = u[ib.nodal_dofs[2]]
tipn = np.abs(m.p[0] - 100) < 0.1
I = 10**4 / 12
print("tip deflection FEA %.3f mm, beam theory %.3f mm (+shear %.3f)" % (-uz[tipn].mean(), 10*100**3/(3*fea.E*I), 10*100**3/(3*fea.E*I) + 10*100/( (5/6)*100*fea.E/(2*(1+fea.NU)))))
w = ib.interpolate(u); g = w.grad; eps = 0.5*(g+np.transpose(g,(1,0,2,3)))
sxx = 2*mu*eps[0,0] + lam*(eps[0,0]+eps[1,1]+eps[2,2])
X = ib.global_coordinates().value[0]
sel = (X > 45) & (X < 55)
print("bending stress at mid-span FEA max %.2f MPa, beam theory %.2f MPa" % (np.abs(sxx[sel]).max(), 10*50*5/I))
