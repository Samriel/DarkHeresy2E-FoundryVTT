#!/usr/bin/env python3
"""Build the system and install it (Linux counterpart of createReleaseZip.ps1).

    python3 utils/release.py build    npm run build + full system folder in ./release
    python3 utils/release.py zip      build, then dark-heresy.zip for a GitHub release
    python3 utils/release.py local    build, back up and replace the local Foundry system
    python3 utils/release.py server   build, back up and replace the system on the campaign server

Foundry must not run the world while the system is replaced: local — close Foundry,
server — Return to Setup (the server keeps running, the files are swapped under it).
"""
import json
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
RELEASE = ROOT / "release"
COPY = ["asset", "lang", "logo", "packs", "template", "CONTRIBUTING.md", "README.md", "LICENSE",
        "system.json", "template.json"]
LOCAL = pathlib.Path.home() / ".local/share/FoundryVTT/Data/systems/dark-heresy"
BACKUPS = pathlib.Path.home() / "foundry-backups"
HOST = "foundry@95.182.87.35"
KEY = pathlib.Path.home() / ".ssh/id_ed25519"
SSH = ["ssh", "-o", "BatchMode=yes", "-i", str(KEY), HOST]
REMOTE = "foundrydata/Data/systems/dark-heresy"


def build():
    shutil.rmtree(RELEASE, ignore_errors=True)
    subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
    for name in COPY:
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, RELEASE / name)
        else:
            shutil.copy2(src, RELEASE / name)
    version = json.loads((ROOT / "system.json").read_text())["version"]
    print(f"Собрана система {version} в {RELEASE}")
    return version


def stamp():
    return time.strftime("%Y%m%d-%H%M%S")


def local():
    if subprocess.run(["pgrep", "-f", "resources/app/main.js|/foundryvtt/foundryvtt"],
                      capture_output=True).returncode == 0:
        sys.exit("Локальный Foundry запущен: закрой его.")
    build()
    BACKUPS.mkdir(exist_ok=True)
    archive = BACKUPS / f"system-dark-heresy-{stamp()}.tar.gz"
    subprocess.run(["tar", "-czf", str(archive), "-C", str(LOCAL.parent), LOCAL.name], check=True)
    # packs/ keeps the LevelDB the server created; replace everything else
    for child in LOCAL.iterdir():
        if child.name != "packs":
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    for child in RELEASE.iterdir():
        if child.name == "packs" and (LOCAL / "packs").exists():
            continue
        dst = LOCAL / child.name
        shutil.copytree(child, dst) if child.is_dir() else shutil.copy2(child, dst)
    print(f"Система заменена локально; копия до этого — {archive}")


def server():
    status = subprocess.run(SSH + ["curl -s -m5 http://127.0.0.1:30000/api/status"],
                            capture_output=True, text=True, check=True).stdout
    if json.loads(status).get("active"):
        sys.exit("На сервере открыт мир: выйди в Setup (Return to Setup) и запусти снова.")
    build()
    s = stamp()
    subprocess.run(SSH + [f"mkdir -p ~/backups && tar -czf ~/backups/system-dark-heresy-{s}.tar.gz "
                          f"-C {REMOTE}/.. dark-heresy"], check=True)
    subprocess.run(["rsync", "-a", "--delete", "--exclude", "packs/", "-e", f"ssh -o BatchMode=yes -i {KEY}",
                    f"{RELEASE}/", f"{HOST}:{REMOTE}/"], check=True)
    print(f"Система заменена на сервере; копия до этого — ~/backups/system-dark-heresy-{s}.tar.gz")
    print("Перезапусти сервис, чтобы Foundry перечитал system.json: sudo systemctl restart foundry.service")


def zip_release():
    build()
    target = ROOT / "dark-heresy.zip"
    target.unlink(missing_ok=True)
    shutil.make_archive(str(target.with_suffix("")), "zip", RELEASE)
    print(f"Архив для релиза — {target}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    {"build": build, "zip": zip_release, "local": local, "server": server}.get(cmd, lambda: sys.exit(__doc__))()
