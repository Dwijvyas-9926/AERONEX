#!/usr/bin/env python3
"""
Build AERONEX's parameter definitions from an ArduPilot source checkout.

    python3 scripts/param-metadata/generate.py <ardupilot-checkout> <out.json>

It runs ArduPilot's own Tools/autotest/param_metadata/param_parse.py, the tool
that produces the documentation Mission Planner and ardupilot.org use, so the
text is the firmware's own. Two things differ from ArduPilot's apm.pdef.json:

* Every definition is kept. When two libraries define the same name (the
  helicopter and multirotor attitude controllers, the battery-monitor
  back-ends) the stock JSON keeps whichever came last; for ATC_RAT_RLL_P that
  is the helicopter range. Here the multirotor (or most common) definition is
  the main one and the helicopter one is kept beside it.
* The output is compact: short keys, numbers as numbers.

Keys per parameter: n display name, d description, u units, r [low, high],
i increment, v [[value, label], ...], b [[bit, label], ...], rb reboot needed,
adv advanced, ro read-only, cal set by a calibration, vol changes by itself,
h the helicopter definition (same keys) where it differs.
"""
import json
import os
import re
import runpy
import sys
import types

src, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
pm = os.path.join(src, "Tools", "autotest", "param_metadata")
sys.path.insert(0, pm)
from emit import Emit  # noqa: E402
from param import known_units  # noqa: E402

rows = []


class Collect(Emit):
    def emit(self, g):
        keep = getattr(self, "should_emit_param", lambda p: True)
        for p in g.params:
            if not keep(p):
                continue
            d = {k: v for k, v in p.__dict__.items() if not k.startswith("__") and k not in ("SortValues",)}
            d["name"] = d["name"].split(":")[-1]
            d["file"] = os.path.basename(p.real_path)
            rows.append(d)

    def close(self):
        pass


fake = types.ModuleType("jsonemit")
fake.JSONEmit = Collect
sys.modules["jsonemit"] = fake
sys.argv = ["param_parse.py", "--vehicle", "Copter", "--format", "json"]
cwd = os.getcwd()
os.chdir(os.path.dirname(out) or ".")
try:
    runpy.run_path(os.path.join(pm, "param_parse.py"), run_name="__main__")
except SystemExit:
    pass
os.chdir(cwd)

version = re.search(r'THISFIRMWARE "ArduCopter V([\d.]+)', open(os.path.join(src, "ArduCopter", "version.h")).read()).group(1)


def num(s):
    s = str(s).strip()
    try:
        f = float(s)
    except ValueError:
        return None
    return int(f) if f.is_integer() and "." not in s and "e" not in s.lower() else f


def pairs(text):
    outp = []
    for part in str(text).split(","):
        if ":" not in part:
            continue
        k, label = part.split(":", 1)
        k = num(k)
        if k is None:
            continue
        outp.append([k, label.strip()])
    return sorted(outp, key=lambda kv: kv[0])


def compact(r):
    c = {"n": r.get("DisplayName", "").strip(), "d": re.sub(r"\s+", " ", r.get("Description", "")).strip()}
    if r.get("Units"):
        c["u"] = r["Units"].strip()
    if r.get("Range"):
        lo, hi = (num(x) for x in r["Range"].split()[:2])
        if lo is not None and hi is not None:
            c["r"] = [lo, hi]
    if r.get("Increment") and num(r["Increment"]) is not None:
        c["i"] = num(r["Increment"])
    if r.get("Values"):
        c["v"] = pairs(r["Values"])
    if r.get("Bitmask"):
        c["b"] = pairs(r["Bitmask"])
    if str(r.get("RebootRequired", "")).strip().lower() == "true":
        c["rb"] = 1
    if str(r.get("User", "")).strip() == "Advanced":
        c["adv"] = 1
    if str(r.get("ReadOnly", "")).strip().lower() == "true":
        c["ro"] = 1
    if str(r.get("Calibration", "")).strip() == "1":
        c["cal"] = 1
    if str(r.get("Volatile", "")).strip().lower() == "true":
        c["vol"] = 1
    return c


# Which definition is the main one when several libraries share a name.
PREFER = ["Multi", "Analog", "SMBus", "INA2xx", "Single"]


def rank(r):
    f = r["file"]
    for i, key in enumerate(PREFER):
        if key in f:
            return i
    return len(PREFER) + (1 if "Heli" in f else 0)


by_name = {}
for r in rows:
    by_name.setdefault(r["name"], []).append(r)

params = {}
for name, defs in sorted(by_name.items()):
    defs.sort(key=rank)
    main = compact(defs[0])
    heli = next((d for d in defs if "Heli" in d["file"]), None)
    if heli is not None and heli is not defs[0]:
        h = compact(heli)
        diff = {k: v for k, v in h.items() if main.get(k) != v}
        if diff:
            main["h"] = diff
    params[name] = main

doc = {
    "firmware": "ArduCopter " + version,
    "source": "ArduPilot param_parse.py, ArduCopter " + version + " source",
    "units": {k: v for k, v in sorted(known_units.items())},
    "params": params,
}
with open(out, "w") as f:
    json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
print(f"{len(params)} parameters from ArduCopter {version} -> {out} ({os.path.getsize(out) // 1024} KB)")
