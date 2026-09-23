"""Download TikTok Sans / Montserrat / Inter from the npm registry (fontsource) and write the .ttf
files render.py expects into app/fonts. Runs during the Docker build so no binaries live in git."""
import io, os, sys, tarfile, urllib.request
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app", "fonts")
os.makedirs(OUT, exist_ok=True)


def pkg(name, version):
    scope, short = name.split("/")
    url = f"https://registry.npmjs.org/{name}/-/{short}-{version}.tgz"
    data = urllib.request.urlopen(url, timeout=60).read()
    return tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")


def save_static(tar, member, out_name):
    f = TTFont(io.BytesIO(tar.extractfile(member).read()))
    f.flavor = None
    f.save(os.path.join(OUT, out_name + ".ttf"))


for family, fname in [("@fontsource/tiktok-sans", "tiktok-sans"), ("@fontsource/montserrat", "montserrat"),
                      ("@fontsource/inter", "inter")]:
    t = pkg(family, "5.3.0")
    for w in ("500", "700", "800"):
        save_static(t, f"package/files/{fname}-latin-{w}-normal.woff", f"{fname}-{w}")

# condensed TikTok Sans (the narrow Instagram/TikTok caption look)
t = pkg("@fontsource-variable/tiktok-sans", "5.3.0")
raw = t.extractfile("package/files/tiktok-sans-latin-wdth-normal.woff2").read()
for wg in (500, 600):
    f = TTFont(io.BytesIO(raw))
    g = instancer.instantiateVariableFont(f, {"wdth": 75, "wght": wg})
    g.flavor = None
    g.save(os.path.join(OUT, f"tiktok-sans-cond-{wg}.ttf"))

print("fonts:", sorted(os.listdir(OUT)))
