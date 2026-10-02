"""Resumable, hash-verified downloads for large pinned dependency wheels."""
from __future__ import annotations
import argparse
import concurrent.futures
import hashlib
import os
import time
import urllib.request
from pathlib import Path


def download(url, destination, expected_sha256, workers=4):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and _hash(destination) == expected_sha256:
        return str(destination)
    with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=120) as response:
        size = int(response.headers["Content-Length"])
    span = (size + workers - 1) // workers
    parts = []

    def fetch(index):
        start, end = index * span, min((index + 1) * span, size) - 1
        part = destination.with_suffix(destination.suffix + f".part{index}")
        attempt = 0
        while attempt < 12:
            actual = part.stat().st_size if part.exists() else 0
            if actual == end - start + 1:
                return part
            if actual > end - start + 1:
                raise ValueError("Invalid existing part length")
            try:
                request_end = min(start + actual + 8 * 1024 * 1024 - 1, end)
                request = urllib.request.Request(url, headers={"Range": f"bytes={start + actual}-{request_end}"})
                with urllib.request.urlopen(request, timeout=120) as response:
                    if response.status != 206 or not response.headers.get("Content-Range", "").startswith(f"bytes {start + actual}-"):
                        raise ValueError("Server did not honor the byte range")
                    with part.open("ab") as stream:
                        while block := response.read(1024 * 1024):
                            stream.write(block)
                attempt = 0
                print(f"DOWNLOAD part {index + 1}/{workers}: {part.stat().st_size}/{end-start+1}", flush=True)
            except (OSError, TimeoutError) as error:
                print(f"DOWNLOAD part {index + 1} retry {attempt + 1}: {error}", flush=True)
                attempt += 1
                time.sleep(min(2 ** attempt, 30))
        raise RuntimeError(f"Download retries exhausted: {part}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        parts = list(pool.map(fetch, range(workers)))
    temp = destination.with_suffix(destination.suffix + ".assembling")
    with temp.open("wb") as stream:
        for part in parts:
            with part.open("rb") as chunk:
                while block := chunk.read(4 * 1024 * 1024):
                    stream.write(block)
    actual = _hash(temp)
    if actual != expected_sha256:
        raise ValueError(f"SHA256 mismatch: {actual}")
    os.replace(temp, destination)
    # Only remove this download's verified, fully assembled parts.
    for part in parts:
        part.unlink()
    print(f"VERIFIED {destination} SHA256 {actual}", flush=True)
    return str(destination)


def _hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(4 * 1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("destination")
    parser.add_argument("sha256")
    args = parser.parse_args()
    download(args.url, args.destination, args.sha256)
