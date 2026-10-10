#!/usr/bin/env python3
"""Check downloaded files and Lite splits, and write an honest completion inventory."""
import csv
import hashlib
import json
import time
from pathlib import Path
from download import ROOT, read_json, save_json, sha256


def main():
    issues = []
    manifest = ROOT / 'metadata/assets-files.json'
    migration_file = ROOT / 'metadata/infiagent-path-migration.json'
    if manifest.exists() and migration_file.exists():
        migration = read_json(migration_file)
        records = read_json(manifest)
        records = [r for r in records if r['path'] not in migration['removed']]
        for r in records:
            r['path'] = migration['mapping'].get(r['path'],r['path'])
        records = list({r['path']:r for r in records}.values())
        save_json(manifest, records)
    checked = 0
    for manifest in ROOT.glob('metadata/*-files.json'):
        for rec in read_json(manifest):
            path = ROOT / rec['path']
            if not path.is_file() or path.stat().st_size != rec['bytes'] or sha256(path) != rec['sha256']:
                issues.append('manifest mismatch: '+rec['path'])
            else:
                checked += 1
    expected_da = [f for f in read_json(ROOT/'metadata/dacomp-hf') if f['path'].endswith('.sqlite')]
    da_count = 0
    for f in expected_da:
        p = ROOT / 'dacomp-da/public' / f['path']
        if p.exists() and p.stat().st_size==f['size']:
            if 'lfs' in f:
                valid = sha256(p)==f['lfs']['oid']
            else:
                data=p.read_bytes()
                valid=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==f['oid']
            if valid:da_count += 1
    ds_tasks = read_json(ROOT/'metadata/ds-modeling-selection.json')['included']
    ds_count = 0
    for task in ds_tasks:
        paths = [ROOT/'dsbench/modeling/public'/task/f for f in ['task.txt','train.csv','test.csv']]
        paths.append(ROOT/'dsbench/modeling/private'/task/'test_answer.csv')
        if all(p.exists() and p.stat().st_size for p in paths):ds_count += 1
    arena_count = 0
    for row in csv.DictReader((ROOT/'metadata/arena-meta').open()):
        if row['repeat']!='0' or row['fold']!='0':continue
        base = ROOT/'tabarena-lite/raw'/row['task_id_str']
        if not (base/'splits-r0-f0.csv').exists():continue
        meta = read_json(base/'dataset.json')['data_set_description']
        if (base/'data.parquet').exists() and (base/'parquet-source.json').exists():
            import pyarrow.parquet as pq
            parquet = base/'data.parquet'
            receipt = read_json(base/'parquet-source.json')
            table = pq.read_table(parquet)  # Read every row group to detect unreadable/truncated data.
            data_ok = (sha256(parquet)==receipt['sha256']
                       and parquet.stat().st_size==receipt['bytes']
                       and receipt['dataset_id']==meta['id'] and receipt['version']==meta['version']
                       and receipt['url']==meta['parquet_url']
                       and table.num_rows==int(float(row['num_instances']))
                       and table.num_columns==int(float(row['num_features']))+1
                       and meta['default_target_attribute'] in table.column_names)
        elif (base/'data.arff').exists():
            data_ok = hashlib.md5((base/'data.arff').read_bytes()).hexdigest()==meta.get('md5_checksum')
        else:
            continue
        splits = list(csv.DictReader((base/'splits-r0-f0.csv').open()))
        n = int(float(row['num_instances']))
        ok = (data_ok and len(splits)==n
              and {int(r['rowid']) for r in splits}==set(range(n))
              and all(r['repeat']=='0' and r['fold']=='0' for r in splits)
              and abs(sum(r['type']=='TRAIN' for r in splits)-float(row['num_instances_train']))<=1
              and abs(sum(r['type']=='TEST' for r in splits)-float(row['num_instances_test']))<=1)
        if ok:arena_count+=1
        else:issues.append('invalid OpenML data/split: '+row['task_id_str'])
    infi = ROOT/'infiagent-dabench/public'
    infi_q = len((infi/'questions.jsonl').read_text().splitlines()) if (infi/'questions.jsonl').exists() else 0
    infi_tables = len(list((infi/'tables').glob('*.csv')))
    analysis_path = ROOT/'dsbench/analysis/public/tasks.jsonl'
    analysis = [json.loads(l) for l in analysis_path.read_text().splitlines()] if analysis_path.exists() else []
    summary = {
        'date':'2026-10-10', 'checked_at':time.strftime('%Y-%m-%d %H:%M:%S %z'),
        'file_manifest_checks_passed':checked, 'issues':issues,
        'dacomp_da':{'verified_databases':da_count,'expected':100},
        'dsbench_analysis':{'cases':len(analysis),'questions':sum(len(r['questions']) for r in analysis),'expected_cases':38},
        'infiagent_dabench':{'questions':infi_q,'tables':infi_tables,'expected_questions':257,'expected_tables':52},
        'dsbench_modeling':{'complete_task_directories':ds_count,'expected':52},
        'tabarena_lite':{'verified_datasets_and_splits':arena_count,'expected':51},
        'logical_bytes_by_directory':{
            name:sum(p.stat().st_size for p in (ROOT/name).rglob('*') if p.is_file() and not p.name.endswith(('.part','-part','.tmp')))
            for name in ['dacomp-da','dsbench','infiagent-dabench','tabarena-lite']},
        'training_or_agent_evaluation_run':False,
    }
    summary['all_required_downloads_complete'] = (
        not issues and da_count==100 and ds_count==52 and arena_count==51
        and infi_q==257 and infi_tables==52 and len(analysis)==38
        and len(read_json(ROOT/'metadata/assets-files.json'))==2087)
    save_json(ROOT/'metadata/download-status.json',summary)
    print(json.dumps(summary,ensure_ascii=False,indent=2))
    return not summary['all_required_downloads_complete']


if __name__=='__main__':
    raise SystemExit(1 if main() else 0)
