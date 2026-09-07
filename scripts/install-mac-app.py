#!/usr/bin/env python3
"""Build the local launcher and append it to the Dock without replacing other tiles."""
import datetime
import json
import pathlib
import plistlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = pathlib.Path.home() / "Applications" / "Ai-FormaDesk.app"
BUNDLE_ID = "local.ai-formadesk.launcher"


def run(*args):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} 执行失败：{result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def install():
    launcher = ROOT / "启动 Ai-FormaDesk.command"
    if not launcher.is_file():
        raise RuntimeError("找不到启动脚本，请保留应用对应的项目文件夹。")
    if APP.exists():
        info = plistlib.loads((APP / "Contents/Info.plist").read_bytes())
        if info.get("CFBundleIdentifier") != BUNDLE_ID:
            raise RuntimeError(f"已有同名应用，未覆盖：{APP}")
    APP.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ai-formadesk-app-") as temporary:
        directory = pathlib.Path(temporary)
        staged = directory / APP.name
        source = directory / "launcher.applescript"
        source.write_text(
            'on run\n  do shell script "/usr/bin/open " & quoted form of '
            + json.dumps(str(launcher), ensure_ascii=False)
            + '\nend run\n', encoding="utf-8")
        run("/usr/bin/osacompile", "-o", str(staged), str(source))
        icons = directory / "FormaDesk.iconset"
        icons.mkdir()
        run("/usr/bin/swift", str(ROOT / "scripts/create-app-icon.swift"), str(icons))
        run("/usr/bin/iconutil", "-c", "icns", str(icons), "-o",
            str(staged / "Contents/Resources/FormaDesk.icns"))
        info_path = staged / "Contents/Info.plist"
        info = plistlib.loads(info_path.read_bytes())
        # osacompile supplies an asset catalog which takes precedence over ICNS.
        # Remove its icon-name reference and explicitly use our own resource.
        info.pop("CFBundleIconName", None)
        info.update(CFBundleIdentifier=BUNDLE_ID, CFBundleName="Ai-FormaDesk",
                    CFBundleDisplayName="Ai-FormaDesk", CFBundleShortVersionString="1.0.1",
                    CFBundleVersion="2", CFBundleIconFile="FormaDesk.icns",
                    NSHighResolutionCapable=True)
        info_path.write_bytes(plistlib.dumps(info))
        run("/usr/bin/codesign", "--force", "--sign", "-", str(staged))
        # Preserve the previous launcher if this installer is run again.
        if APP.exists():
            backup = ROOT / "data/launcher-backups" / datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            backup.mkdir(parents=True)
            shutil.move(str(APP), str(backup / APP.name))
        shutil.copytree(staged, APP)
    run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        "-f", str(APP))
    dock_data = run("/usr/bin/defaults", "export", "com.apple.dock", "-")
    dock = plistlib.loads(dock_data)
    url = APP.as_uri() + "/"
    backup = ROOT / "data/launcher-backups"
    backup.mkdir(parents=True, exist_ok=True)
    (backup / (datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f") + "-dock.plist")).write_bytes(dock_data)
    tile = {"tile-type": "file-tile", "tile-data": {
        "file-data": {"_CFURLString": url, "_CFURLStringType": 15},
        "file-label": "Ai-FormaDesk", "bundle-identifier": BUNDLE_ID,
        "file-type": 41}}
    tiles = []
    inserted = False
    for existing in dock.get("persistent-apps", []):
        details = existing.get("tile-data", {})
        same_app = (details.get("bundle-identifier") == BUNDLE_ID or
                    details.get("file-data", {}).get("_CFURLString", "").rstrip("/") == url.rstrip("/"))
        if same_app:
            # Rebind this tile: an old bookmark may follow the backed-up app.
            if not inserted:
                tiles.append(tile)
                inserted = True
        else:
            tiles.append(existing)
    if not inserted:
        tiles.append(tile)
    run("/usr/bin/defaults", "write", "com.apple.dock", "persistent-apps", "-array",
        *(plistlib.dumps(entry).decode() for entry in tiles))
    subprocess.run(["/usr/bin/killall", "Dock"], check=False, capture_output=True)
    print(f"已安装并保留在程序坞：{APP}")


if __name__ == "__main__":
    install()
