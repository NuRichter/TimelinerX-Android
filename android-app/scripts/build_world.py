"""Build the Offline World basemap (public/world/*) from Natural Earth (public domain).

Coordinates are projected to normalised Web Mercator (x, y in 0..1, y down), quantised to 2^25
units per world width and stored as zig-zag varint deltas. Detailed land is clipped into a grid
so a map tile only draws the cells it touches. Run once; the output is committed.
    python scripts/build_world.py <natural-earth-geojson-dir>
"""
import json, math, os, struct, sys
from shapely.geometry import shape, box, Polygon, MultiPolygon, LineString, MultiLineString
from shapely.ops import transform
from shapely.validation import make_valid

NE = sys.argv[1] if len(sys.argv) > 1 else 'ne'
OUT = 'public/world'
Q = 1 << 25
MAXLAT = 85.05112878
os.makedirs(OUT, exist_ok=True)

def merc(lon, lat, z=None):
    lat = max(-MAXLAT, min(MAXLAT, lat))
    x = (lon + 180.0) / 360.0
    y = (1 - math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) / math.pi) / 2
    return x, y

def proj(geom):
    return transform(_p, geom)

def _p(xs, ys):
    ox, oy = [], []
    for a, b in zip(xs, ys):
        x, y = merc(a, b); ox.append(x); oy.append(y)
    return ox, oy

def varint(n, out):
    n = (n << 1) ^ (n >> 63)  # zigzag (python ints are unbounded; values fit easily)
    n &= (1 << 64) - 1
    while True:
        b = n & 0x7F; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return

def enc_rings(rings):
    data = bytearray(); counts = []
    for ring in rings:
        pts = list(ring)
        if len(pts) < 2: continue
        px = py = 0; n = 0
        for x, y in pts:
            qx, qy = int(round(x * Q)), int(round(y * Q))
            varint(qx - px, data); varint(qy - py, data); px, py = qx, qy; n += 1
        counts.append(n)
    return counts, bytes(data)

def polys(g):
    if g.is_empty: return []
    if isinstance(g, Polygon): return [g]
    if isinstance(g, MultiPolygon): return list(g.geoms)
    if hasattr(g, 'geoms'): return [p for x in g.geoms for p in polys(x)]
    return []

def lines(g):
    if g.is_empty: return []
    if isinstance(g, LineString): return [g]
    if isinstance(g, MultiLineString): return list(g.geoms)
    if hasattr(g, 'geoms'): return [p for x in g.geoms for p in lines(x)]
    return []

def load(name):
    return [f for f in json.load(open(os.path.join(NE, name + '.geojson'), encoding='utf-8'))['features'] if f.get('geometry')]

layers = []
def poly_layer(name, role, minz, maxz, grid, simplify=0.0):
    feats = []
    geoms = []
    for f in load(name):
        g = make_valid(shape(f['geometry']))
        g = proj(g)
        if simplify: g = g.simplify(simplify, preserve_topology=True)
        geoms.extend(polys(g))
    cells = [(0, 0, 1, 1)] if grid <= 1 else [(i / grid, j / grid, (i + 1) / grid, (j + 1) / grid) for i in range(grid) for j in range(grid)]
    for p in geoms:
        pb = p.bounds
        for c in cells:
            if pb[2] < c[0] or pb[0] > c[2] or pb[3] < c[1] or pb[1] > c[3]: continue
            q = p if grid <= 1 else p.intersection(box(*c))
            for part in polys(q):
                rings = [part.exterior.coords] + [r.coords for r in part.interiors]
                counts, data = enc_rings(rings)
                if counts: feats.append((part.bounds, counts, data))
    layers.append((1, minz, maxz, role, feats))
    npts = sum(sum(c) for _, c, _ in feats)
    print(f'{name}: {len(feats)} features, {npts} points, {sum(len(d) for *_, d in feats)/1e6:.2f} MB')

def line_layer(name, role, minz, maxz):
    feats = []
    for f in load(name):
        g = proj(shape(f['geometry']))
        for ln in lines(g):
            counts, data = enc_rings([ln.coords])
            if counts: feats.append((ln.bounds, counts, data))
    layers.append((2, minz, maxz, role, feats))
    print(f'{name}: {len(feats)} lines')

poly_layer('ne_110m_land', 1, 0, 2, 1)
poly_layer('ne_50m_land', 1, 3, 5, 16)
poly_layer('ne_10m_land', 1, 6, 30, 64)
poly_layer('ne_50m_lakes', 2, 3, 30, 1)
line_layer('ne_50m_admin_0_boundary_lines_land', 3, 2, 5)
line_layer('ne_10m_admin_0_boundary_lines_land', 3, 6, 30)

buf = bytearray(b'TLXW')
buf += struct.pack('<II', 1, len(layers))
for kind, minz, maxz, role, feats in layers:
    buf += struct.pack('<BBBBI', kind, minz, maxz, role, len(feats))
    for bounds, counts, data in feats:
        buf += struct.pack('<ffffHI', *bounds, len(counts), len(data))
        buf += struct.pack('<%dI' % len(counts), *counts)
        buf += data
open(os.path.join(OUT, 'world.bin'), 'wb').write(buf)
print('world.bin', len(buf) / 1e6, 'MB')

# populated places with names in the 10 video languages
langs = ['en', 'id', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'zh', 'ja']
places = []
for f in load('ne_10m_populated_places'):
    p = f['properties']
    mz = p.get('MIN_ZOOM') or 10
    if mz > 9: continue
    lon, lat = f['geometry']['coordinates'][:2]
    x, y = merc(lon, lat)
    base = p.get('NAME_EN') or p.get('NAME')
    names = {}
    for l in langs[1:]:
        v = p.get('NAME_' + l.upper())
        if v and v != base: names[l] = v
    cap = 1 if p.get('ADM0CAP') else 0
    places.append([round(x, 7), round(y, 7), round(float(mz), 1), int(p.get('SCALERANK') or 10), cap, base, names or 0])
places.sort(key=lambda r: (r[2], r[3], -r[4]))
json.dump(places, open(os.path.join(OUT, 'places.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('places', len(places), os.path.getsize(os.path.join(OUT, 'places.json')) / 1e6, 'MB')
