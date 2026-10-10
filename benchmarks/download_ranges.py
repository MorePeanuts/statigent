"""Resume bounded HTTP ranges, then validate the assembled file before publishing it."""
import argparse
import concurrent.futures
import hashlib
from pathlib import Path
import shutil
import time
import urllib.request


def download(url, dest, size, *, workers=24, chunk_size=512 * 1024, multipart_etag=None, expected_sha256=None):
    dest = Path(dest)
    parts = dest.with_name(dest.name + '.chunks')
    parts.mkdir(parents=True, exist_ok=True)
    ranges = [(i, min(i + chunk_size, size) - 1) for i in range(0, size, chunk_size)]

    def one(bounds):
        start, end = bounds
        target = parts / str(start)
        expected = end - start + 1
        if target.exists() and target.stat().st_size == expected:
            return
        for attempt in range(6):
            try:
                request = urllib.request.Request(url, headers={
                    'Range': f'bytes={start}-{end}', 'Accept-Encoding': 'identity'})
                with urllib.request.urlopen(request, timeout=60) as response:
                    if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{size}':
                        raise ValueError('Server did not return the requested byte range')
                    data = response.read(expected + 1)
                if len(data) != expected:
                    raise ValueError('Truncated range')
                tmp = target.with_suffix('.tmp')
                tmp.write_bytes(data)
                tmp.replace(target)
                return
            except Exception:
                if attempt == 5:
                    raise
                time.sleep(min(2 ** attempt, 8))

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, bounds) for bounds in ranges]
        for n, future in enumerate(concurrent.futures.as_completed(futures), 1):
            future.result()
            if n % 10 == 0 or n == len(ranges):
                print(f'Ranges verified: {n}/{len(ranges)}', flush=True)
    output = dest.with_name(dest.name + '.assembled-part')
    with output.open('wb') as stream:
        for start, end in ranges:
            stream.write((parts / str(start)).read_bytes())
    if output.stat().st_size != size:
        raise ValueError('Assembled size mismatch')
    if expected_sha256 and hashlib.sha256(output.read_bytes()).hexdigest() != expected_sha256:
        output.unlink()
        shutil.rmtree(parts)
        raise ValueError('Official SHA-256 mismatch')
    # This source uses a multipart ETag with 5 MiB parts, verified against its HEAD response.
    if multipart_etag:
        hashes = []
        with output.open('rb') as stream:
            while block := stream.read(5 * 1024 * 1024):
                hashes.append(hashlib.md5(block).digest())
        actual = hashlib.md5(b''.join(hashes)).hexdigest() + '-' + str(len(hashes))
        if actual != multipart_etag:
            output.unlink()
            shutil.rmtree(parts)
            raise ValueError('Official multipart ETag mismatch')
    output.replace(dest)
    shutil.rmtree(parts)
    print(f'Download verified: {dest} ({size} bytes)', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('dest')
    parser.add_argument('size', type=int)
    parser.add_argument('--multipart-etag')
    args = parser.parse_args()
    download(args.url, args.dest, args.size, multipart_etag=args.multipart_etag)
