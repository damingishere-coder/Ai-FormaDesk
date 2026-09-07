#!/usr/bin/env python3
"""Install only explicitly selected, pinned local image3d components.

No model is fetched during inference. Large downloads use resumable .part files;
only size + SHA-256 verified files become usable model weights.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import threading
import signal
import fcntl

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads((ROOT / 'image3d/runtime.lock.json').read_text())


def emit(event, **values):
    print(json.dumps({'event': event, **values}, ensure_ascii=False), flush=True)


def sha256(file):
    h = hashlib.sha256()
    with file.open('rb') as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def space(root, remaining):
    free = shutil.disk_usage(root).free
    required = remaining + LOCK['reserveBytes']
    if free < required:
        raise RuntimeError(f'磁盘空间不足：需要 {required / 2**30:.1f} GiB（含 10 GiB 余量），可用 {free / 2**30:.1f} GiB')


def resumed_bytes(part, total):
    prefix = min(total, part.stat().st_size) if part.exists() else 0
    chunks = part.with_suffix('.chunks')
    complete = 0
    for start in range(0, total, 4*1024*1024):
        end = min(start+4*1024*1024,total)
        chunk = chunks/str(start)
        if end <= prefix or (chunk.is_file() and chunk.stat().st_size == end-start):
            complete += end-start
    return complete


def parallel_download(root, url, part, total, workers, expected_hash):
    """Bounded range downloads; final hash remains the authority, never a mirror."""
    chunk_size = 4 * 1024 * 1024
    chunks = part.with_suffix('.chunks')
    chunks.mkdir(exist_ok=True)
    ranges = [(i, min(i + chunk_size, total)) for i in range(0, total, chunk_size)]
    # Preserve and reuse full chunks from an interrupted sequential download.
    if part.exists():
        with part.open('rb') as source:
            for start, end in ranges:
                if end > part.stat().st_size:
                    break
                target = chunks / str(start)
                if not target.exists():
                    source.seek(start)
                    target.write_bytes(source.read(end - start))
    space(root, total * 2 - sum(f.stat().st_size for f in chunks.iterdir() if f.is_file()))
    cancelled = threading.Event()
    processes = set()
    mutex = threading.Lock()

    def one(bounds):
        start, end = bounds
        target = chunks / str(start)
        if target.exists() and target.stat().st_size == end - start:
            return end - start
        if cancelled.is_set():
            raise RuntimeError('下载已取消')
        temporary = target.with_suffix('.part')
        cmd = ['/usr/bin/curl', '-fLsS', '--http1.1', '--connect-timeout', '30', '--max-time', '360',
               '--retry', '5', '--retry-all-errors', '--retry-delay', '3', '--max-filesize', str(end - start),
               '--range', f'{start}-{end-1}', '--output', str(temporary), url]
        with mutex:
            if cancelled.is_set():
                raise RuntimeError('下载已取消')
            child = subprocess.Popen(cmd, start_new_session=True, stderr=subprocess.PIPE)
            processes.add(child)
        _, error = child.communicate()
        with mutex:
            processes.discard(child)
        if child.returncode or not temporary.exists() or temporary.stat().st_size != end - start:
            raise RuntimeError(f'分片 {start} 未完成，退出码 {child.returncode}；可重试续传')
        temporary.replace(target)
        return end - start

    pool = ThreadPoolExecutor(max_workers=workers)
    done = 0
    try:
        futures = [pool.submit(one, bounds) for bounds in ranges]
        for f in as_completed(futures):
            done += f.result()
            space(root, 0)
            emit('download-progress', completedBytes=done, totalBytes=total)
    finally:
        cancelled.set()
        with mutex:
            for child in processes:
                if child.poll() is None:
                    try:
                        os.killpg(child.pid, 15)
                    except ProcessLookupError:
                        pass
        pool.shutdown(wait=True, cancel_futures=True)
    assembled = part.with_suffix('.assembling')
    # Other downloads/builds may have consumed space since the first check.
    # Reserve the complete assembly before writing; keep chunks if unavailable.
    space(root, total)
    with assembled.open('wb') as output:
        for start, end in ranges:
            space(root, end-start)
            with (chunks / str(start)).open('rb') as source:
                shutil.copyfileobj(source, output, 1024 * 1024)
    if sha256(assembled) != expected_hash:
        raise RuntimeError('分片合并后 SHA-256 不符；保留分片与合并文件，未启用模型')
    assembled.replace(part)
    shutil.rmtree(chunks)


def download(root, names, workers=1):
    selected = [w for w in LOCK['weights'] if w['name'] in names]
    if set(names) != {w['name'] for w in selected}:
        raise ValueError('未锁定的模型名称')
    remaining = 0
    for w in selected:
        dest = root / 'models' / w['path']
        part = dest.with_suffix(dest.suffix + '.part')
        if not dest.exists():
            remaining += w['size'] - resumed_bytes(part,w['size'])
    space(root, remaining)
    for w in selected:
        dest = root / 'models' / w['path']
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            if dest.stat().st_size != w['size'] or sha256(dest) != w['sha256']:
                raise RuntimeError(f'已有模型校验失败，保留现场：{dest}')
            emit('verified', model=w['name'], path=str(dest))
            continue
        part = dest.with_suffix(dest.suffix + '.part')
        url = f"https://huggingface.co/{w['repo']}/resolve/{w['revision']}/{w['file']}"
        emit('downloading', model=w['name'], bytes=w['size'])
        if workers > 1 and w['size'] > 64 * 1024 * 1024:
            parallel_download(root, url, part, w['size'], workers, w['sha256'])
            if part.stat().st_size != w['size'] or sha256(part) != w['sha256']:
                raise RuntimeError(f'下载校验失败，未启用：{part}')
            part.replace(dest)
            emit('verified', model=w['name'], path=str(dest), sha256=w['sha256'])
            continue
        # curl uses the system trust store; never disable TLS validation.
        cmd = ['/usr/bin/curl', '--fail', '--location', '--show-error', '--silent',
               '--retry', '3', '--retry-delay', '3', '--connect-timeout', '30',
               '--speed-time', '120', '--speed-limit', '1024',
               '--continue-at', '-', '--output', str(part), url]
        child = subprocess.Popen(cmd, start_new_session=True)
        try:
            while child.poll() is None:
                time.sleep(2)
                space(root, 0)
            if child.returncode:
                raise RuntimeError(f'下载未完成（退出码 {child.returncode}）；再次运行将断点续传')
        except BaseException:
            if child.poll() is None:
                os.killpg(child.pid, 15)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, 9)
                    child.wait()
            raise
        if part.stat().st_size != w['size'] or sha256(part) != w['sha256']:
            raise RuntimeError(f'下载校验失败，未启用：{part}')
        part.replace(dest)
        emit('verified', model=w['name'], path=str(dest), sha256=w['sha256'])


def source(root, name):
    spec = LOCK['sources'][name]
    dest = root / 'sources' / name
    fresh = not dest.exists()
    if fresh:
        subprocess.run(['git', 'clone', '--filter=blob:none', '--no-checkout', spec['url'], str(dest)], check=True)
    elif not (dest / '.git').exists():
        raise RuntimeError(f'目录已存在但不是受管理的 Git 源码：{dest}')
    remote = subprocess.check_output(['git', '-C', str(dest), 'remote', 'get-url', 'origin'], text=True).strip()
    if remote != spec['url']:
        raise RuntimeError(f'源码 origin 与锁定清单不一致：{name}')
    dirty = subprocess.check_output(['git', '-C', str(dest), 'status', '--porcelain'], text=True)
    if dirty and not fresh:
        raise RuntimeError(f'外部源码有本地修改，未覆盖：{name}')
    if name == 'stablegen':
        subprocess.run(['git', '-C', str(dest), 'sparse-checkout', 'set', '--cone', 'stablegen'], check=True)
    subprocess.run(['git', '-C', str(dest), 'checkout', '--detach', spec['commit']], check=True)
    emit('source-ready', name=name, commit=spec['commit'])


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime', type=Path, default=ROOT / 'data/image3d-runtime')
    p.add_argument('--source', action='append', choices=list(LOCK['sources']), default=[])
    p.add_argument('--weights', action='append', choices=[w['name'] for w in LOCK['weights']], default=[])
    p.add_argument('--workers', type=int, choices=range(1, 65), default=1)
    args = p.parse_args()
    root = args.runtime.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root / 'sources').mkdir(exist_ok=True)
    emit('preflight', runtime=str(root), freeBytes=shutil.disk_usage(root).free)
    with (root/'installation.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('已有模型安装任务运行，请等待或取消后重试')
        for name in args.source:
            source(root, name)
        if args.weights:
            download(root, args.weights, args.workers)


if __name__ == '__main__':
    def interrupted(*_):raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM,interrupted)
    try:
        main()
    except KeyboardInterrupt:
        emit('cancelled',message='安装已取消，完整分片保留，可再次续传')
        sys.exit(130)
    except (RuntimeError, ValueError, subprocess.CalledProcessError) as e:
        emit('error', message=str(e))
        sys.exit(1)
