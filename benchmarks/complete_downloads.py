#!/usr/bin/env python3
"""One-shot coordinator: finish the current downloads, retry failures, then verify.

This is a finite download job, not a recurring scheduler. Status is saved locally.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import shutil
import threading
import time
from download import ROOT, read_json, save_json

GUARD = threading.Lock()
STATUS = {}
COMMANDS = {
    'assets':['download.py','assets'],
    'dacomp':['download_xet.py'],
    'modeling':['download.py','modeling'],
    'tabarena':['download.py','tabarena'],
}


def update(group, **fields):
    with GUARD:
        STATUS.setdefault(group,{}).update(fields)
        save_json(ROOT/'metadata/background-status.json',dict(
            updated_at=time.strftime('%Y-%m-%d %H:%M:%S %z'), jobs=STATUS))


def still_running(pid, command_fragment):
    try:
        result=subprocess.run(['ps','-p',str(pid),'-o','stat=,args='],capture_output=True,text=True)
        text=result.stdout.strip()
        return bool(text) and not text.startswith('Z') and command_fragment in text
    except OSError:
        return False


def complete(group):
    name, count = {
        'assets':('assets-files.json',2087),
        'dacomp':('dacomp-data-files.json',102),
        'modeling':('ds-modeling-files.json',208),
        'tabarena':('tabarena-tasks.json',51),
    }[group]
    path=ROOT/'metadata'/name
    if not path.exists():return False
    records=read_json(path)
    if group=='assets':
        migration=read_json(ROOT/'metadata/infiagent-path-migration.json')
        records=[r for r in records if r['path'] not in migration['removed']]
        for r in records:r['path']=migration['mapping'].get(r['path'],r['path'])
        records=list({r['path']:r for r in records}.values())
        save_json(path,records)
    if len(records)!=count:return False
    if group!='tabarena':
        return all((ROOT/r['path']).exists() and (ROOT/r['path']).stat().st_size==r['bytes'] for r in records)
    return all((ROOT/r['split_path']).exists() for r in records)


def finish_group(group, original):
    pid=original['pid']
    update(group,state='downloading',pid=pid)
    while still_running(pid,original['command_fragment']):
        time.sleep(15)
    for attempt in range(3):
        if complete(group):
            update(group,state='downloaded',pid=None)
            return
        update(group,state='retrying',attempt=attempt+1)
        command=['uv','run','python',str(ROOT/COMMANDS[group][0]),*COMMANDS[group][1:]]
        with (ROOT/'.logs'/('retry-'+group+'.log')).open('a') as log:
            proc=subprocess.Popen(command,cwd=ROOT.parent,stdout=log,stderr=subprocess.STDOUT)
            update(group,pid=proc.pid)
            proc.wait()
    update(group,state='incomplete_after_retries',pid=None)


def main():
    (ROOT/'.logs').mkdir(exist_ok=True)
    jobs=read_json(ROOT/'metadata/active-jobs.json')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures=[pool.submit(finish_group,k,v) for k,v in jobs.items()]
        for f in futures:f.result()
    with (ROOT/'.logs/verification.log').open('w') as log:
        result=subprocess.run(['uv','run','--python',str(ROOT/'.venv/bin/python'),'python',str(ROOT/'verify.py')],cwd=ROOT.parent,
                              stdout=log,stderr=subprocess.STDOUT)
    if result.returncode==0:
        # Only remove temporary files once every required benchmark is verified.
        for dirname in ['dacomp-da','dsbench','tabarena-lite','infiagent-dabench']:
            for path in (ROOT/dirname).rglob('*'):
                if path.is_file() and path.name.endswith(('.part','-part','.tmp')):
                    path.unlink()
        for path in (ROOT/'tabarena-lite').rglob('all-splits.arff'):
            path.unlink()
        shutil.rmtree(ROOT/'.xet-cache',ignore_errors=True)
        readme=ROOT/'README.md'
        readme.write_text(readme.read_text().replace('**当前大文件仍在下载。**','**主基准已全部下载并通过校验。**'))
        update('verification',state='all_required_downloads_verified')
    else:
        readme=ROOT/'README.md'
        readme.write_text(readme.read_text().replace('**当前大文件仍在下载。**','**下载作业已结束，仍有项目需要处理。**'))
        update('verification',state='needs_attention',log='.logs/verification.log')
    print('Coordinator finished; see metadata/download-status.json',flush=True)


if __name__=='__main__':
    main()
