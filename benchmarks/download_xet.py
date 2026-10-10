#!/usr/bin/env python3
"""Optional compressed Xet transport for DAComp's large SQLite files.

Requires hf_xet==1.7.0, installed separately; the ordinary downloader is stdlib-only.
"""
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parent
os.environ.setdefault('HF_XET_CACHE', str(ROOT / '.xet-cache'))
sys.path.insert(0, str(ROOT / '.tools'))
import hf_xet
from download import fetch, read_json, save_json, sha256


def main():
    revision = read_json(ROOT / 'metadata/revisions.json')['DAComp/dacomp-da']
    files = [f for f in read_json(ROOT / 'metadata/dacomp-hf') if f['type'] == 'file']
    token_url = 'https://huggingface.co/api/datasets/DAComp/dacomp-da/xet-read-token/' + revision
    records = []
    pending = []
    config = hf_xet.XetConfig().with_config({
        'client.ac_initial_download_concurrency': 64,
        'client.ac_max_download_concurrency': 64,
        'client.ac_min_download_concurrency': 64,
        'data.max_concurrent_file_downloads': 18,
        'reconstruction.min_reconstruction_fetch_size': 1000000,
        'reconstruction.max_reconstruction_fetch_size': 1000000,
        'reconstruction.download_buffer_size': 512000000,
        'reconstruction.download_buffer_perfile_size': 64000000,
        'reconstruction.download_buffer_limit': 1024000000,
        'reconstruction.min_prefetch_buffer': 64000000,
    })
    session = hf_xet.XetSession(config=config)
    def progress(total, items):
        save_json(ROOT/'metadata/dacomp-transfer-progress.json', {
            'updated_at': time.strftime('%Y-%m-%d %H:%M:%S %z'),
            'bytes_completed': total.total_bytes_completed,
            'total_bytes': total.total_bytes,
            'transfer_bytes_completed': total.total_transfer_bytes_completed,
            'transfer_bytes_per_second': total.total_transfer_bytes_completion_rate,
        })
    with session.new_file_download_group(token_refresh_url=token_url,
            progress_callback=progress, progress_interval_ms=30000) as group:
        for f in files:
            dest = ROOT / 'dacomp-da/public' / f['path']
            dest.parent.mkdir(parents=True, exist_ok=True)
            url = 'https://huggingface.co/datasets/DAComp/dacomp-da/resolve/' + revision + '/' + f['path']
            if 'xetHash' not in f:
                records.append(fetch(url, dest, f['size']))
                continue
            if dest.exists() and dest.stat().st_size == f['size'] and sha256(dest) == f['lfs']['oid']:
                records.append(dict(path=str(dest.relative_to(ROOT)), url=url, bytes=f['size'], sha256=f['lfs']['oid']))
                continue
            part = dest.with_name(dest.name + '.xet-part')
            if part.exists() and part.stat().st_size == f['size'] and sha256(part) == f['lfs']['oid']:
                part.replace(dest)
                records.append(dict(path=str(dest.relative_to(ROOT)), url=url, bytes=f['size'], sha256=f['lfs']['oid']))
                continue
            group.start_download_file(hf_xet.XetFileInfo(f['xetHash'], f['size']), str(part))
            pending.append((f, dest, part, url))
        print('Xet queued', len(pending), 'SQLite files; waiting for compressed transfers', flush=True)
    for f, dest, part, url in pending:
        digest = sha256(part)
        if part.stat().st_size != f['size'] or digest != f['lfs']['oid']:
            raise ValueError('Xet SHA-256/size mismatch: ' + f['path'])
        part.replace(dest)
        previous = dest.with_name(dest.name + '.part')
        previous.unlink(missing_ok=True)
        records.append(dict(path=str(dest.relative_to(ROOT)), url=url, bytes=f['size'], sha256=digest))
    save_json(ROOT / 'metadata/dacomp-data-files.json', sorted(records,key=lambda x:x['path']))
    print('DAComp verified', len(records), 'files', flush=True)


if __name__ == '__main__':
    main()
