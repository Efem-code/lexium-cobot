import sys, zipfile, numpy as np, trimesh
D = sys.argv[1]; out = sys.argv[2]
parts = [("Mount (print this)", "p_mount", "#F59B1E"), ("Flange (arm, reference)", "p_flange", "#B4B4B4"),
         ("SICK TiM", "p_tim", "#505050"), ("SICK SEC110", "p_cam", "#3C78B4"), ("Screws, dowel, strap", "p_hw", "#202020")]
meshes = [trimesh.load(f"{D}/{f}.stl", force="mesh") for _, f, _ in parts]
zmin = min(m.bounds[0][2] for m in meshes)
res = ['<?xml version="1.0" encoding="UTF-8"?>',
       '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
       '<resources>', '<basematerials id="1">'] + [f'<base name="{n}" displaycolor="{c}"/>' for n, _, c in parts] + ['</basematerials>']
for i, ((name, _, _), m) in enumerate(zip(parts, meshes)):
    v = m.vertices - [0, 0, zmin]
    res.append(f'<object id="{i+2}" name="{name}" type="model" pid="1" pindex="{i}"><mesh><vertices>')
    res += [f'<vertex x="{a:.4f}" y="{b:.4f}" z="{c:.4f}"/>' for a, b, c in v]
    res.append('</vertices><triangles>')
    res += [f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in m.faces]
    res.append('</triangles></mesh></object>')
n = len(parts) + 2
res.append(f'<object id="{n}" name="TiM + SEC110 mount assembly" type="model"><components>' +
           "".join(f'<component objectid="{i+2}"/>' for i in range(len(parts))) + '</components></object>')
res += ['</resources>', f'<build><item objectid="{n}" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build>', '</model>']
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    z.writestr("3D/3dmodel.model", "\n".join(res))
print("wrote", out, [len(m.faces) for m in meshes])
