"""Reference output of the desktop (Python) engine for test/parity.test.js.
Run from android-app/:  python scripts/parity_reference.py   (needs numpy + python-dateutil)
"""
import json, sys, glob, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'src'))
from timelinerx.timeline.parser import load_timeline
from timelinerx.journeys.journey import build_journey, JourneyConfig
from timelinerx.camera.planner import plan_frames, CameraConfig, recommend_duration
import numpy as np
out = {}
FIXDIR = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')
fx = sorted(glob.glob(os.path.join(FIXDIR, '*.json')) + glob.glob(os.path.join(FIXDIR, 'upstream', '*sample*.json')))
for f in fx:
    name = os.path.relpath(f, FIXDIR).replace(os.sep, '/')
    rec = {}
    try:
        tl = load_timeline(f, compute_sha=False)
    except Exception as e:
        out[name] = {'import_error': type(e).__name__}
        continue
    s, r = tl.semantic, tl.raw
    rec['sem_n'] = len(s); rec['raw_n'] = len(r)
    rec['sem_t'] = s.t.tolist(); rec['sem_lat'] = s.lat.tolist(); rec['sem_lon'] = s.lon.tolist()
    rec['sem_mode'] = s.mode.tolist(); rec['sem_kind'] = s.kind.tolist(); rec['sem_off'] = s.offset_min.tolist()
    rec['raw_t'] = r.t.tolist()[:50]
    d = tl.diagnostics
    rec['diag'] = dict(skipped=d.skipped, reversed=d.direction_reversed, dups=d.duplicates_removed,
                       standalone=d.standalone_paths_dropped, format=d.detected_format)
    for src in ('semantic', 'detailed'):
        try:
            j = build_journey(tl, JourneyConfig(route_source=src))
        except Exception as e:
            rec['journey_'+src] = {'error': type(e).__name__}; continue
        jr = dict(n=len(j.lats), total_km=j.total_km, legs=j.legs, hop_mode=j.hop_mode.tolist(),
                  arcs=sorted(j.arcs.keys()), outliers=j.outliers_removed, days=j.stats['days'])
        if src == 'semantic' and len(j.lats) >= 2 and j.total_km > 0:
            for mode in ('active', 'balanced', 'fixed', 'close_up'):
                cfg = CameraConfig(mode=mode)
                p = plan_frames(j, cfg, width=640, height=360, fps=24, duration_s=20)
                jr['plan_'+mode] = dict(cx=p.cx.tolist(), cy=p.cy.tolist(), sy=p.span_y.tolist(), md=p.marker_d.tolist(),
                                        phase=p.phase.tolist())
            p = plan_frames(j, CameraConfig(mode='active', pacing='distance'), width=360, height=640, fps=30, duration_s=15)
            jr['plan_distance_portrait'] = dict(cx=p.cx.tolist(), cy=p.cy.tolist(), sy=p.span_y.tolist(), md=p.marker_d.tolist())
            jr['recommend'] = recommend_duration(j, CameraConfig(), 1920, 1080)
        rec['journey_'+src] = jr
    out[name] = rec
os.makedirs('test/ref', exist_ok=True)
json.dump(out, open('test/ref/parity_ref_full.json', 'w'))
print(len(out), 'fixtures')
for k, v in out.items():
    print(k, v.get('import_error') or (v['sem_n'], v['raw_n'], v['journey_semantic'].get('total_km') if isinstance(v.get('journey_semantic'), dict) else None))
