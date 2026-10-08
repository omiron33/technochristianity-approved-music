#!/usr/bin/env python3
"""Prepare immutable compressed copies of current Music Studio approvals.

This script stages files locally. It does not upload, publish, or alter Studio.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

STUDIO = os.environ.get("STUDIO_ORIGIN", "http://127.0.0.1:4319")
DATA_DIR = Path(os.environ.get("STUDIO_DATA_DIR", Path.home() / "Library/Application Support/Music Studio"))
TOKEN = (DATA_DIR / "api-token").read_text().strip()
ALLOWED_REMOTE = (
    "https://omiron33.github.io/technochristianity-assets/",
    "https://omiron33.github.io/technochristianity-approved-music/",
)


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def fetch(url):
    headers = {"Authorization": f"Bearer {TOKEN}"} if url.startswith(STUDIO) else {}
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def source_for(work, sources, source_wav=None):
    take = next((item for item in work.get("takes", []) if item.get("id") == work.get("approvedTakeId")), None)
    if not take or not take.get("approved"):
        raise RuntimeError(f"{work['id']}: selected take is not approved")
    if source_wav:
        candidate = source_wav.expanduser().resolve(strict=True)
        if not candidate.is_file() or candidate.suffix.lower() != ".wav":
            raise RuntimeError("The selected Suno export must be a local WAV file")
        data = candidate.read_bytes()
        if data[:4] not in (b"RIFF", b"RF64") or data[8:12] != b"WAVE":
            raise RuntimeError("The selected Suno export is not a WAV file")
    else:
        url = work.get("audioUrl") or ""
        if url.startswith("/media/"):
            data = fetch(STUDIO + url)
        elif any(url.startswith(prefix) for prefix in ALLOWED_REMOTE):
            data = fetch(url)
        else:
            raise RuntimeError(f"{work['id']}: approved audio has no downloadable source")
    if data.startswith(b"version https://git-lfs.github.com/spec/v1"):
        raise RuntimeError(f"{work['id']}: Studio source is a Git LFS pointer; restore the real audio before delivery")
    if source_wav:
        masters = DATA_DIR / "suno-wav-masters"
        masters.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(masters, 0o700)
        filename = (work["id"].replace(":", "-") + "-" + work["approvedTakeId"] +
                    "-" + hashlib.sha256(data).hexdigest()[:16] + ".wav")
        path = masters / filename
    else:
        path = sources / (work["id"].replace(":", "-") + ".source")
    if not path.exists():
        path.write_bytes(data)
        os.chmod(path, 0o600)
    elif digest(path) != hashlib.sha256(data).hexdigest():
        raise RuntimeError(f"{work['id']}: preserved source path has different bytes")
    if take.get("sha256") and digest(path) != take["sha256"]:
        raise RuntimeError(f"{work['id']}: downloaded source differs from the approved take")
    return path


def codec(path):
    return subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ], text=True).strip()


def slug_for(work):
    if work.get("kind") == "chapter" and work.get("book") and work.get("chapter"):
        slug = f"{work['book']}-{work['chapter']}"
    else:
        slug = work["id"].removeprefix("thematic:")
    slug = slug.lower().replace(":", "-")
    if any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in slug):
        raise RuntimeError(f"{work['id']}: unsafe slug")
    return slug


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-id", help="Stage one Studio work ID; omit to stage all eligible works")
    parser.add_argument("--source-wav", type=Path,
                        help="Exact approved Suno WAV observed and downloaded by the local browser agent")
    parser.add_argument("--staging", type=Path, default=DATA_DIR / "r2-staging")
    args = parser.parse_args()
    if args.source_wav and not args.work_id:
        parser.error("--source-wav requires --work-id")
    studio = json.loads(fetch(STUDIO + "/api/v1/studio"))
    if studio.get("settings", {}).get("paused"):
        raise RuntimeError("Music Studio global runner is paused")
    works = [work for work in studio["works"] if work.get("audioStatus") == "approved" and
             work.get("approvedTakeId") and (work.get("kind") != "chapter" or
             work.get("sunoFinalization", {}).get("status") == "verified" or
             work.get("publications", {}).get("website", {}).get("status") == "verified")]
    if args.work_id:
        works = [work for work in works if work["id"] == args.work_id]
    if not works:
        raise RuntimeError("No eligible approved works found")
    staging = args.staging.resolve()
    sources = staging / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    records = []
    for work in works:
        source = source_for(work, sources, args.source_wav)
        source_hash = digest(source)
        source_codec = codec(source)
        if not source_codec:
            raise RuntimeError(f"{work['id']}: source has no audio stream")
        if args.source_wav and not source_codec.startswith("pcm_"):
            raise RuntimeError(f"{work['id']}: Suno WAV is not uncompressed PCM audio")
        extension = "m4a" if source_codec == "aac" else "mp3"
        slug = slug_for(work)
        output = staging / f"{slug}.tmp.{extension}"
        if source_codec in ("mp3", "aac"):
            shutil.copyfile(source, output)
        else:
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
                "-map", "0:a:0", "-map_metadata", "-1", "-c:a", "libmp3lame", "-q:a", "2",
                "-metadata", f"title={work['title']}", "-metadata", "artist=TechnoChristianity", str(output),
            ], check=True)
        audio_hash = digest(output)
        key = f"audio/{slug}/{audio_hash[:16]}.{extension}"
        destination = staging / key
        destination.parent.mkdir(parents=True, exist_ok=True)
        output.replace(destination)
        records.append({"workId": work["id"], "title": work["title"], "approvedTakeId": work["approvedTakeId"],
                        "sourceSha256": source_hash, "sourceCodec": source_codec, "sha256": audio_hash,
                        "bytes": destination.stat().st_size,
                        "contentType": "audio/mp4" if extension == "m4a" else "audio/mpeg", "key": key})
        print(f"{work['id']}: {source_codec} -> {key}")
    manifest_path = staging / "manifest.json"
    # The staging manifest is one delivery batch. The verified release manifest
    # retains other chapters after this batch passes all public checks.
    manifest_path.write_text(json.dumps({"formatVersion": 1, "provider": "cloudflare-r2", "objects": records}, indent=2) + "\n")
    print(f"Staged {len(works)} approved song(s); no public upload was made")


if __name__ == "__main__":
    main()
