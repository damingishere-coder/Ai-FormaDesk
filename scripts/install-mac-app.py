#!/usr/bin/env python3
"""Install the built desktop app, preserving prior launchers and Dock entries."""
import argparse
import datetime
import pathlib
import plistlib
import shutil
import subprocess
import json

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = pathlib.Path.home() / 'Applications' / 'Ai-FormaDesk.app'
APP_ID = 'com.formadesk.desktop'
LEGACY_ID = 'local.ai-formadesk.launcher'
SUPPORT = pathlib.Path.home() / 'Library/Application Support/Ai-FormaDesk'


def run(*args):
    p = subprocess.run(args, capture_output=True)
    if p.returncode:
        raise RuntimeError(f'{args[0]} 执行失败：{p.stderr.decode(errors="replace").strip()}')
    return p.stdout


def install(data_dir=None, mcp_runtime=None):
    built = ROOT / 'release/mac-arm64/Ai-FormaDesk.app'
    if not built.is_dir():
        raise RuntimeError('请先运行 npm run desktop:dist 构建桌面应用。')
    info = plistlib.loads((built / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != APP_ID:
        raise RuntimeError('构建产物标识不符，未安装。')
    if APP.exists():
        existing = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
        if existing.get('CFBundleIdentifier') not in (APP_ID, LEGACY_ID):
            raise RuntimeError('已有其他同名应用，未覆盖。')
        executable = APP / 'Contents/MacOS' / existing.get('CFBundleExecutable', '')
        running = subprocess.run(['/usr/sbin/lsof', '-t', str(executable)], capture_output=True)
        if running.stdout.strip():
            raise RuntimeError('请先退出正在运行的 Ai-FormaDesk，再覆盖安装。')
    config = SUPPORT / 'desktop-settings.json'
    values = json.loads(config.read_text()) if config.exists() else {}
    if not isinstance(values, dict):
        raise RuntimeError('已有路径设置无效，未替换应用。')
    if data_dir:
        data = pathlib.Path(data_dir).resolve(strict=True)
        if not (data / 'index.sqlite').is_file():
            raise RuntimeError('指定作品目录缺少 index.sqlite，未替换应用。')
        values['dataDir'] = str(data)
    if mcp_runtime:
        runtime = pathlib.Path(mcp_runtime).resolve(strict=True)
        if not (runtime / 'runtime.json').is_file():
            raise RuntimeError('指定 MCP 目录缺少 runtime.json，未替换应用。')
        values['mcpRuntime'] = str(runtime)
    SUPPORT.mkdir(parents=True, exist_ok=True)
    backup = SUPPORT / 'launcher-backups' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup.mkdir(parents=True)
    staged = APP.with_name('Ai-FormaDesk-installing.app')
    if staged.exists():
        raise RuntimeError(f'已有安装暂存目录，请检查：{staged}')
    temporary = None
    if data_dir or mcp_runtime:
        if config.exists():
            shutil.copy2(config, backup / config.name)
        temporary = config.with_suffix('.tmp')
        temporary.write_text(json.dumps(values, ensure_ascii=False, indent=2))
        temporary.chmod(0o600)
    APP.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(built, staged, symlinks=True)
    if APP.exists():
        shutil.move(str(APP), str(backup / APP.name))
    try:
        staged.rename(APP)
        if temporary:
            temporary.replace(config)
    except Exception:
        if APP.exists():
            shutil.move(str(APP), str(backup / 'failed-new-app.app'))
        if (backup / APP.name).exists():
            shutil.move(str(backup / APP.name), str(APP))
        raise
    run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', '-f', str(APP))
    dock_data = run('/usr/bin/defaults', 'export', 'com.apple.dock', '-')
    (backup / 'dock.plist').write_bytes(dock_data)
    dock = plistlib.loads(dock_data)
    url = APP.as_uri() + '/'
    tile = {'tile-type': 'file-tile', 'tile-data': {'file-data': {'_CFURLString': url, '_CFURLStringType': 15}, 'file-label': 'Ai-FormaDesk', 'bundle-identifier': APP_ID, 'file-type': 41}}
    tiles, inserted = [], False
    for entry in dock.get('persistent-apps', []):
        detail = entry.get('tile-data', {})
        ours = detail.get('bundle-identifier') in (APP_ID, LEGACY_ID) or detail.get('file-data', {}).get('_CFURLString', '').rstrip('/') == url.rstrip('/')
        if ours:
            if not inserted:
                tiles.append(tile)
                inserted = True
        else:
            tiles.append(entry)
    if not inserted:
        tiles.append(tile)
    run('/usr/bin/defaults', 'write', 'com.apple.dock', 'persistent-apps', '-array', *(plistlib.dumps(entry).decode() for entry in tiles))
    subprocess.run(['/usr/bin/killall', 'Dock'], capture_output=True)
    print(f'已安装独立桌面应用：{APP}\n旧入口备份：{backup}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', help='继续使用现有作品目录，不移动文件；请先退出旧工作台')
    parser.add_argument('--mcp-runtime', help='现有 Blender MCP 运行时目录')
    args = parser.parse_args()
    install(args.data_dir, args.mcp_runtime)
