#!/usr/bin/env python3
"""Download only the frozen benchmark selection; never run agents or training.

Python standard library only. See README.md for scope and access restrictions.
"""
import argparse
import concurrent.futures
import csv
import hashlib
import gzip
import io
import json
import os
from pathlib import Path
import shutil
import struct
import threading
import time
import urllib.parse
import urllib.request
import zipfile
import zlib

ROOT = Path(__file__).resolve().parent
LOCK = threading.Lock()
RANGE_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=64)


def read_json(path):
    return json.loads(path.read_text())


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def fetch(url, dest, size=None, expected_sha=None, expected_md5=None):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and (size is None or dest.stat().st_size == size):
        digest = sha256(dest)
        md5_ok = expected_md5 is None or hashlib.md5(dest.read_bytes()).hexdigest() == expected_md5
        if (expected_sha is None or digest == expected_sha) and md5_ok:
            return dict(path=str(dest.relative_to(ROOT)), url=url,
                        bytes=dest.stat().st_size, sha256=digest)
    part = dest.with_name(dest.name + '.part')
    for attempt in range(5):
        try:
            offset = part.stat().st_size if part.exists() else 0
            headers = {'User-Agent': 'statigent-benchmark-fetch/1.0'}
            if offset:
                headers['Range'] = 'bytes=%d-' % offset
            else:
                headers['Accept-Encoding'] = 'gzip'
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
                if offset and r.status != 206:
                    offset = 0
                if offset:
                    assert r.headers.get('Content-Range', '').startswith('bytes %d-' % offset)
                with part.open('ab' if offset else 'wb') as f:
                    source = gzip.GzipFile(fileobj=r) if r.headers.get('Content-Encoding') == 'gzip' else r
                    shutil.copyfileobj(source, f, 1024 * 1024)
                if r.headers.get('Content-Encoding') != 'gzip' and r.headers.get('Content-Length'):
                    if part.stat().st_size-offset != int(r.headers['Content-Length']):
                        raise ValueError('Truncated HTTP response')
            if size is not None and part.stat().st_size != size:
                raise ValueError('download size mismatch')
            digest = sha256(part)
            if expected_sha and digest != expected_sha:
                part.unlink()
                raise ValueError('SHA-256 mismatch')
            if expected_md5 and hashlib.md5(part.read_bytes()).hexdigest() != expected_md5:
                part.unlink()
                raise ValueError('OpenML MD5 mismatch')
            part.replace(dest)
            return dict(path=str(dest.relative_to(ROOT)), url=url,
                        bytes=dest.stat().st_size, sha256=digest)
        except Exception:
            if attempt == 4:
                raise
            time.sleep(min(2 ** attempt, 8))


def save_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(path.suffix + '.tmp')
    part.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')
    part.replace(path)


def run_jobs(group, jobs, workers):
    manifest = ROOT / 'metadata' / (group + '-files.json')
    records = {x['path']: x for x in read_json(manifest)} if manifest.exists() else {}
    errors = []
    def one(job):
        try:
            rec = fetch(job['url'], ROOT / job['path'], job.get('size'), job.get('sha256'))
            with LOCK:
                records[rec['path']] = rec
                save_json(manifest, sorted(records.values(), key=lambda x: x['path']))
            return True
        except Exception as e:
            with LOCK:
                errors.append(dict(path=job['path'], error=str(e)))
                print('FAILED', job['path'], str(e), flush=True)
            return False
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for i, ok in enumerate(pool.map(one, jobs), 1):
            if i % 50 == 0 or i == len(jobs):
                print(group, '%d/%d' % (i, len(jobs)), 'errors', len(errors), flush=True)
    save_json(ROOT / 'metadata' / (group + '-errors.json'), errors)
    return errors


def github_jobs(repo, tree_file, prefix, select):
    tree = read_json(ROOT / 'metadata' / tree_file)
    for f in tree['tree']:
        if f['type'] == 'blob' and select(f['path']):
            yield dict(url='https://raw.githubusercontent.com/%s/%s/%s' % (
                repo, tree['sha'], urllib.parse.quote(f['path'])),
                path=prefix + '/' + f['path'], size=f['size'])


def assets():
    tables = set(read_json(ROOT / 'metadata/infiagent-table-selection.json'))
    jobs = list(github_jobs('InfiAgent/InfiAgent', 'infi-tree', 'infiagent-dabench/upstream',
        lambda p: p in ['LICENSE', 'examples/DA-Agent/README_eval.md', 'examples/DA-Agent/eval_closed_form.py']
        or p in ['examples/DA-Agent/data/da-dev-questions.jsonl','examples/DA-Agent/data/da-dev-labels.jsonl']
        or (p.startswith('examples/DA-Agent/data/da-dev-tables/') and Path(p).name in tables)))
    for job in jobs:
        path = job['path']
        if '/da-dev-tables/' in path:
            job['path'] = 'infiagent-dabench/public/tables/' + Path(path).name
        elif path.endswith('/da-dev-questions.jsonl'):
            job['path'] = 'infiagent-dabench/public/questions.jsonl'
        elif path.endswith('/da-dev-labels.jsonl'):
            job['path'] = 'infiagent-dabench/private/labels.jsonl'
    jobs += list(github_jobs('ByteDance-Seed/DAComp', 'dacomp-tree', 'dacomp-da/evaluator/upstream',
        lambda p: p in ['LICENCE', 'dacomp-da/evaluation_suite/README.md', 'requirements.txt']
        or p.startswith('dacomp-da/evaluation_suite/core/')
        or p.startswith('dacomp-da/evaluation_suite/src/')
        or p in ['dacomp-da/evaluation_suite/get_score.py', 'dacomp-da/evaluation_suite/llm_judge.py']))
    jobs += list(github_jobs('LiqiangJing/DSBench', 'ds-tree.json', 'dsbench/upstream',
        lambda p: p in ['LICENSE', 'README.md', 'data_analysis/data.json', 'data_analysis/readme.md',
        'data_analysis/compute_answer.py', 'data_analysis/show_result.py', 'data_modeling/data.json',
        'data_modeling/readme.md', 'data_modeling/score4each_com.py', 'data_modeling/show_result.py',
        'data_modeling/save_performance.zip'] or p.startswith('data_modeling/evaluation/')))
    return run_jobs('assets', jobs, 16)


def dacomp():
    meta = read_json(ROOT / 'metadata' / 'revisions.json')
    rev = meta['DAComp/dacomp-da']
    jobs = [dict(url='https://huggingface.co/datasets/DAComp/dacomp-da/resolve/%s/%s' % (rev, f['path']),
                 path='dacomp-da/public/' + f['path'], size=f['size'], sha256=f.get('lfs', {}).get('oid'))
            for f in read_json(ROOT / 'metadata' / 'dacomp-hf') if f['type'] == 'file']
    return run_jobs('dacomp-data', jobs, 4)


def analysis():
    rev = read_json(ROOT / 'metadata' / 'revisions.json')['liqiang888/DSBench']
    url = 'https://huggingface.co/datasets/liqiang888/DSBench/resolve/%s/data_analysis/data.zip' % rev
    archive = ROOT / 'dsbench/analysis/data.zip'
    rec = fetch(url, archive, 8027257)
    tree = read_json(ROOT / 'metadata/ds-tree.json')
    index_path = ROOT / 'dsbench/analysis/private/tasks-with-answers.jsonl'
    index_rec = fetch('https://raw.githubusercontent.com/LiqiangJing/DSBench/' + tree['sha'] + '/data_analysis/data.json', index_path)
    tasks = [json.loads(line) for line in index_path.read_text().splitlines() if line.strip()]
    included = {r['id'] for r in tasks}
    archive_cases = set()
    with zipfile.ZipFile(archive) as z:
        for f in z.infolist():
            parts = Path(f.filename).parts
            if f.is_dir() or '..' in parts or f.filename.startswith('/') or '__MACOSX' in parts or '.DS_Store' in parts:
                continue
            relative = Path(*parts[1:]) if parts[0] == 'data' else Path(*parts)
            archive_cases.add(relative.parts[0])
            if relative.parts[0] not in included:
                continue
            dest = ROOT / 'dsbench/analysis' / ('private' if 'answer' in f.filename.lower() else 'public') / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(f) as src, dest.open('wb') as out:
                shutil.copyfileobj(src, out)
    public_index = ROOT / 'dsbench/analysis/public/tasks.jsonl'
    public_index.write_text(''.join(json.dumps({k:v for k,v in r.items() if k != 'answers'}, ensure_ascii=False) + '\n' for r in tasks))
    save_json(ROOT / 'metadata/ds-analysis-selection.json', dict(included=sorted(included),
        excluded_archive_only=sorted(archive_cases-included), questions=sum(len(r['questions']) for r in tasks)))
    save_json(ROOT / 'metadata/ds-analysis-index.json', index_rec)
    save_json(ROOT / 'metadata/ds-analysis-archive.json', rec)
    archive.unlink()
    return []


def _range_bytes(url, start, end):
    # A distinct URL avoids proxy caches returning a different previous range.
    url += '?range=%d-%d' % (start, end)
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={'Range': 'bytes=%d-%d' % (start, end)})
            with urllib.request.urlopen(req, timeout=60) as r:
                if r.status != 206 or not r.headers.get('Content-Range', '').startswith('bytes %d-%d/' % (start, end)):
                    raise ValueError('Server did not honor the requested ZIP byte range')
                b = r.read()
                if len(b) != end - start + 1:
                    raise ValueError('Truncated range')
                return b
        except Exception:
            if attempt == 4:
                raise
            time.sleep(min(2 ** attempt, 8))


def range_bytes(url, start, end):
    # Bound each transfer so a slow large response does not block a whole task.
    step = 256 * 1024
    if end-start+1 <= step:
        return _range_bytes(url,start,end)
    requests = [RANGE_POOL.submit(_range_bytes,url,pos,min(pos+step-1,end))
                for pos in range(start,end+1,step)]
    return b''.join(f.result() for f in requests)


def modeling():
    selection = read_json(ROOT / 'metadata/ds-modeling-selection.json')
    included = set(selection['included'])
    rev = read_json(ROOT / 'metadata/revisions.json')['liqiang888/DSBench']
    url = 'https://huggingface.co/datasets/liqiang888/DSBench/resolve/%s/data_modeling/data.zip' % rev
    entries = read_json(ROOT / 'metadata/ds-zip-entries.json')
    jobs = []
    for e in entries:
        parts = Path(e['name']).parts
        if len(parts) < 3 or parts[0] != 'data':
            continue
        if e['name'].endswith('/') or any(p.startswith('.') for p in parts):
            continue
        # Official processed input + held-out labels, not Kaggle's old submission templates.
        if parts[1] == 'task':
            task = Path(parts[-1]).stem
            filename = 'task.txt'
        elif parts[1] in ['data_resplit', 'answers'] and len(parts) == 4:
            task, filename = parts[2], parts[3]
        else:
            continue
        if task not in included or filename not in ['train.csv', 'test.csv', 'test_answer.csv', 'task.txt']:
            continue
        e = dict(e)
        e['dest'] = 'dsbench/modeling/' + ('private/' if filename == 'test_answer.csv' else 'public/') + task + '/' + filename
        jobs.append(e)
    records, errors = [], []
    def one(e):
        dest = ROOT / e['dest']
        try:
            valid = dest.exists() and dest.stat().st_size == e['size']
            if valid:
                crc = 0
                with dest.open('rb') as f:
                    for b in iter(lambda: f.read(1024 * 1024), b''):
                        crc = zlib.crc32(b, crc)
                valid = crc == e['crc']
            if not valid:
                head = range_bytes(url, e['offset'], e['offset'] + 29)
                fnlen, extralen = struct.unpack_from('<HH', head, 26)
                start = e['offset'] + 30 + fnlen + extralen
                dest.parent.mkdir(parents=True, exist_ok=True)
                part = dest.with_name(dest.name + '.part')
                decoder = zlib.decompressobj(-15) if e['method'] == 8 else None
                if e['method'] not in [0, 8]:
                    raise ValueError('Unsupported ZIP compression')
                crc = 0
                with part.open('wb') as out:
                    for pos in range(start, start + e['compressed'], 1024 * 1024):
                        b = range_bytes(url, pos, min(pos + 1024 * 1024, start + e['compressed']) - 1)
                        b = decoder.decompress(b) if decoder else b
                        crc = zlib.crc32(b, crc)
                        out.write(b)
                    if decoder:
                        b = decoder.flush(); out.write(b); crc = zlib.crc32(b, crc)
                if crc != e['crc'] or part.stat().st_size != e['size']:
                    raise ValueError('ZIP member CRC/size mismatch')
                part.replace(dest)
            rec = dict(path=e['dest'], url=url, archive_member=e['name'], bytes=e['size'], sha256=sha256(dest), crc32=e['crc'])
            with LOCK:
                records.append(rec)
                save_json(ROOT / 'metadata/ds-modeling-files.json', sorted(records, key=lambda x:x['path']))
        except Exception as err:
            with LOCK:
                errors.append(dict(path=e['dest'], error=str(err)))
                print('FAILED', e['dest'], str(err), flush=True)
    print('DS modeling selected files', len(jobs), 'compressed MB', round(sum(x['compressed'] for x in jobs)/1e6), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
        for i, _ in enumerate(pool.map(one, jobs), 1):
            if i % 20 == 0 or i == len(jobs):
                print('DS modeling', i, '/', len(jobs), 'errors', len(errors), flush=True)
    save_json(ROOT / 'metadata/ds-modeling-errors.json', errors)
    return errors


def tabarena():
    rows = [r for r in csv.DictReader((ROOT/'metadata/arena-meta').open()) if r['repeat']=='0' and r['fold']=='0']
    records, errors = [], []
    def one(row):
        tid = row['task_id_str']
        base = ROOT / 'tabarena-lite/raw' / tid
        try:
            task_rec = fetch('https://www.openml.org/api/v1/json/task/' + tid, base/'task.json')
            task = read_json(base/'task.json')['task']
            inputs = {x['name']:x for x in task['input']}
            did = inputs['source_data']['data_set']['data_set_id']
            data_rec = fetch('https://www.openml.org/api/v1/json/data/' + did, base/'dataset.json')
            data = read_json(base/'dataset.json')['data_set_description']
            if did == '46908':
                # Official same-version Parquet mirror supports reliable ranged transfers.
                from download_ranges import download as download_ranges
                parquet = base/'data.parquet'
                receipt = base/'parquet-source.json'
                valid = (parquet.exists() and receipt.exists()
                         and sha256(parquet) == read_json(receipt)['sha256'])
                if not valid:
                    download_ranges(data['parquet_url'], parquet, 35142382,
                                    multipart_etag='91400c137cb140207fcdc2308a5e61ed-7')
                raw_rec = dict(path=str(parquet.relative_to(ROOT)), url=data['parquet_url'],
                               bytes=parquet.stat().st_size, sha256=sha256(parquet))
                save_json(receipt, dict(**raw_rec, dataset_id=did, version=data['version'],
                                       multipart_etag='91400c137cb140207fcdc2308a5e61ed-7'))
            else:
                raw_rec = fetch(data['url'].replace('http:', 'https:'), base/'data.arff', expected_md5=data.get('md5_checksum'))
            # Official split file contains many repeats; keep only Lite's r0f0.
            spliturl = inputs['estimation_procedure']['estimation_procedure']['data_splits_url'].replace('http:', 'https:')
            splitpath = base/'splits-r0-f0.csv'
            if splitpath.exists():
                previous = list(csv.DictReader(splitpath.open()))
                if (len(previous) != int(float(row['num_instances']))
                    or len({r['rowid'] for r in previous}) != len(previous)
                    or abs(sum(r['type']=='TRAIN' for r in previous)-float(row['num_instances_train'])) > 1
                    or abs(sum(r['type']=='TEST' for r in previous)-float(row['num_instances_test'])) > 1):
                    splitpath.unlink()
            if not splitpath.exists():
                expected_rows = int(float(row['num_instances']))
                for attempt in range(5):
                    try:
                        request = urllib.request.Request(spliturl, headers={'Accept-Encoding':'gzip'})
                        in_data, selected = False, []
                        with urllib.request.urlopen(request,timeout=60) as response:
                            stream = gzip.GzipFile(fileobj=response) if response.headers.get('Content-Encoding') == 'gzip' else response
                            for line in io.TextIOWrapper(stream):
                                if line.strip().lower() == '@data':
                                    in_data = True; continue
                                if not in_data or not line.strip() or line.startswith('%'):
                                    continue
                                fields = [s.strip().strip("'\"") for s in next(csv.reader([line.strip()]))]
                                if len(fields) != 4:
                                    raise ValueError('Incomplete OpenML split row')
                                if fields[2] in ['0','0.0'] and fields[3] in ['0','0.0']:
                                    selected.append(fields)
                                    if len(selected) == expected_rows:
                                        break  # Do not download repeats/folds unused by Lite.
                        assert len(selected) == expected_rows, 'Incomplete Lite split'
                        assert len({int(x[1]) for x in selected}) == expected_rows, 'Duplicate row IDs'
                        # These metadata counts can be fold averages, e.g. 3333.3333.
                        # Exact membership/counts come from OpenML's actual r0f0 indices.
                        assert abs(sum(x[0]=='TRAIN' for x in selected)-float(row['num_instances_train'])) <= 1
                        assert abs(sum(x[0]=='TEST' for x in selected)-float(row['num_instances_test'])) <= 1
                        break
                    except Exception:
                        if attempt==4: raise
                        time.sleep(2)
                with splitpath.with_suffix('.tmp').open('w') as out:
                    writer=csv.writer(out);writer.writerow(['type','rowid','repeat','fold']);writer.writerows(selected)
                splitpath.with_suffix('.tmp').replace(splitpath)
                save_json(base/'split-source.json', dict(url=spliturl,repeat=0,fold=0,rows=expected_rows,
                    retrieval='stream stopped after all r0f0 rows; unused repeats/folds were not read'))
                for tmp in [base/'all-splits.arff',base/'all-splits.arff.part']:
                    tmp.unlink(missing_ok=True)
            save_json(base/'lite-metadata.json', row)
            rec = dict(task_id=tid, dataset_id=did, dataset_name=row['dataset_name'], repeat=0, fold=0,
                       files=[task_rec,data_rec,raw_rec],split_path=str(splitpath.relative_to(ROOT)),split_sha256=sha256(splitpath))
            with LOCK:
                records.append(rec)
                save_json(ROOT/'metadata/tabarena-tasks.json',sorted(records,key=lambda x:x['task_id']))
                print('TabArena',len(records),'/ 51',row['dataset_name'],flush=True)
        except Exception as err:
            with LOCK:
                errors.append(dict(task_id=tid,error=str(err)))
                print('FAILED TabArena',tid,str(err),flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(one,rows))
    save_json(ROOT/'metadata/tabarena-errors.json', errors)
    return errors


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('group', choices=['assets','dacomp','analysis','modeling','tabarena'])
    args = parser.parse_args()
    raise SystemExit(1 if globals()[args.group]() else 0)
