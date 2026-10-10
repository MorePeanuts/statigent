"""Download the largest frozen DAComp file with persistent compressed range caching.

The local relay only changes transport. The official hf_xet decoder reconstructs
the SQLite file, which must match the official SHA-256 before publication.
"""
import concurrent.futures
from collections import deque
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time
import urllib.request

from download import ROOT, read_json, save_json, sha256

os.environ.setdefault('HF_XET_CACHE', str(ROOT/'.xet-cache/resumable'))
os.environ['NO_PROXY'] = os.environ['no_proxy'] = ','.join(filter(None, [
    os.environ.get('NO_PROXY',''), '127.0.0.1,localhost']))
sys.path.insert(0, str(ROOT/'.tools'))
import hf_xet


def main():
    entry = next(f for f in read_json(ROOT/'metadata/dacomp-hf')
                 if f['path']=='dacomp-061/dacomp-061.sqlite')
    revision = read_json(ROOT/'metadata/revisions.json')['DAComp/dacomp-da']
    dest = ROOT/'dacomp-da/public'/entry['path']
    if dest.exists() and sha256(dest)==entry['lfs']['oid']:
        return
    cache = ROOT/'.xet-cache/resumable-blocks'
    cache.mkdir(parents=True, exist_ok=True)
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    lock = threading.Lock()
    plan = None
    expires = 0
    sources = {}
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=64)
    futures = {}
    future_lock = threading.Lock()
    source_lock = threading.Lock()

    def metadata(port):
        nonlocal plan, expires
        with lock:
            if plan is not None and time.time() < expires:
                return plan
            token_url = 'https://huggingface.co/api/datasets/DAComp/dacomp-da/xet-read-token/'+revision
            with urllib.request.urlopen(token_url, timeout=60) as response:
                token = json.load(response)
            request = urllib.request.Request(token['casUrl']+'/v2/reconstructions/'+entry['xetHash'],
                                            headers={'Authorization':'Bearer '+token['accessToken']})
            with direct.open(request, timeout=60) as response:
                result = json.load(response)
            for digest, options in result['xorbs'].items():
                if len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest):
                    raise ValueError('Invalid official block hash')
                for i, option in enumerate(options):
                    key = digest+'/'+str(i)
                    with source_lock:
                        sources[key] = option['url']
                    option['url'] = f'http://127.0.0.1:{port}/blocks/{key}'
            plan = result
            expires = time.time()+600
            return result

    def fetch_chunk(key, start, end):
        path = cache/key/f'{start}-{end}'
        receipt = path.with_suffix('.sha256')
        if path.exists() and path.stat().st_size==end-start+1 and receipt.exists():
            if sha256(path)==receipt.read_text().strip():
                return path
        for attempt in range(8):
            try:
                metadata(server.server_port)
                with source_lock:
                    url = sources[key]
                request = urllib.request.Request(url, headers={'Range':f'bytes={start}-{end}',
                                                              'Accept-Encoding':'identity'})
                with direct.open(request, timeout=60) as response:
                    if response.status!=206 or not response.headers.get('Content-Range','').startswith(f'bytes {start}-{end}/'):
                        raise ValueError('Unexpected compressed byte range')
                    data = response.read(end-start+2)
                if len(data)!=end-start+1:
                    raise ValueError('Truncated compressed range')
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix('.part')
                tmp.write_bytes(data)
                tmp.replace(path)
                receipt.write_text(hashlib.sha256(data).hexdigest()+'\n')
                return path
            except Exception:
                if attempt==7:
                    raise
                time.sleep(min(2**attempt, 8))

    def chunk_future(key, start, end):
        with future_lock:
            identity = (key,start,end)
            future = futures.get(identity)
            if future is None or (future.done() and future.exception() is not None):
                future = futures[identity] = pool.submit(fetch_chunk,key,start,end)
            return future

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *args):
            pass
        def do_GET(self):
            try:
                if '/reconstructions/' in self.path:
                    requested = self.headers.get('Range','')
                    print('Reconstruction range:',requested,flush=True)
                    if requested.startswith('bytes=') and int(requested[6:].split('-')[0])>=entry['size']:
                        self.send_response(416)
                        self.send_header('Content-Range',f"bytes */{entry['size']}")
                        self.send_header('Content-Length','0')
                        self.end_headers()
                        return
                    body = json.dumps(metadata(self.server.server_port)).encode()
                    self.send_response(200)
                    self.send_header('Content-Type','application/json')
                    self.send_header('Content-Length',str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if not self.path.startswith('/blocks/'):
                    self.send_error(404)
                    return
                key = self.path[len('/blocks/'):]
                if key not in sources:
                    self.send_error(404)
                    return
                start,end = map(int,self.headers['Range'].removeprefix('bytes=').split('-'))
                self.send_response(206)
                self.send_header('Content-Range',f'bytes {start}-{end}/{end+1}')
                self.send_header('Content-Length',str(end-start+1))
                self.end_headers()
                bounds = iter((i,min(i+256*1024-1,end)) for i in range(start,end+1,256*1024))
                pending = deque()
                for _ in range(4):
                    if (b:=next(bounds,None)) is not None:
                        pending.append(chunk_future(key,*b))
                while pending:
                    self.wfile.write(pending.popleft().result().read_bytes())
                    self.wfile.flush()
                    if (b:=next(bounds,None)) is not None:
                        pending.append(chunk_future(key,*b))
            except (BrokenPipeError,ConnectionResetError):
                pass
            except Exception as error:
                print('Relay request failed:',type(error).__name__,flush=True)
                self.close_connection = True

    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever,daemon=True).start()
    metadata(server.server_port)
    config = hf_xet.XetConfig().with_config({
        'client.ac_initial_download_concurrency':64,
        'client.ac_min_download_concurrency':64,
        'client.ac_max_download_concurrency':64,
        'client.reconstruction_api_version':2,
        'reconstruction.min_reconstruction_fetch_size':entry['size'],
        'reconstruction.max_reconstruction_fetch_size':entry['size'],
        'reconstruction.download_buffer_size':3600000000,
        'reconstruction.download_buffer_perfile_size':3600000000,
        'reconstruction.download_buffer_limit':3800000000,
        'reconstruction.min_prefetch_buffer':3600000000,
    })
    def progress(total, items):
        completed = [p for p in cache.rglob('*') if p.is_file() and p.suffix not in ['.sha256','.part']]
        save_json(ROOT/'metadata/dacomp-resumable-progress.json', {
            'updated_at':time.strftime('%Y-%m-%d %H:%M:%S %z'),
            'cached_compressed_bytes':sum(p.stat().st_size for p in completed),
            'decoded_bytes':total.total_bytes_completed,
        })
    part = dest.with_name(dest.name+'.resumable-part')
    try:
        session = hf_xet.XetSession(config=config)
        print('Persistent compressed range download started',flush=True)
        with session.new_file_download_group(endpoint=f'http://127.0.0.1:{server.server_port}',
                progress_callback=progress,progress_interval_ms=30000) as group:
            group.start_download_file(hf_xet.XetFileInfo(entry['xetHash'],entry['size']),str(part))
        if part.stat().st_size!=entry['size'] or sha256(part)!=entry['lfs']['oid']:
            raise ValueError('Official SQLite SHA-256/size mismatch')
        part.replace(dest)
        print('Largest DAComp database verified against official SHA-256',flush=True)
    finally:
        server.shutdown()
        server.server_close()
        pool.shutdown(wait=True)


if __name__=='__main__':
    main()
