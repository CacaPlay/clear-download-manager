#!/usr/bin/env python3
"""Fase 15 media-integrity smoke test.

Generates a valid video, a deliberately short video and a physically truncated
video, then exercises the same FFprobe / FFmpeg checks used by the Rust engine.
No network access is required.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, check=check)


def probe(path: Path) -> dict:
    result = run([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration,format_name,size:stream=codec_type,codec_name,duration",
        "-of", "json", str(path),
    ], check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffprobe rejected the file")
    return json.loads(result.stdout)


def number(value: object) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def validate(path: Path, *, expected_duration: float, mode: str = "video_mp4") -> tuple[bool, str]:
    if path.suffix.lower() in {".part", ".ytdl", ".tmp", ".temp"}:
        return False, "temporary output"
    if not path.is_file() or path.stat().st_size < 32 * 1024:
        return False, "missing or too small"
    try:
        metadata = probe(path)
    except Exception as exc:  # noqa: BLE001 - test report needs the exact rejection
        return False, str(exc)
    fmt = metadata.get("format") or {}
    streams = metadata.get("streams") or []
    duration = max(
        number(fmt.get("duration")),
        max((number(stream.get("duration")) for stream in streams), default=0.0),
    )
    has_audio = any(stream.get("codec_type") == "audio" for stream in streams)
    has_video = any(stream.get("codec_type") == "video" for stream in streams)
    if not fmt.get("format_name") or duration < 0.5:
        return False, "invalid container or duration"
    if mode.startswith("video_") and (not has_video or not has_audio):
        return False, "missing requested video/audio streams"
    if mode.startswith("audio_") and not has_audio:
        return False, "missing requested audio stream"
    if expected_duration >= 5 and duration + 0.25 < max(expected_duration * 0.82, 3.0):
        return False, f"duration mismatch: {duration:.3f}s vs expected {expected_duration:.3f}s"

    packet_check = run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror",
        "-err_detect", "explode", "-i", str(path), "-map", "0:v?",
        "-map", "0:a?", "-c", "copy", "-f", "null", "-",
    ], check=False)
    if packet_check.returncode != 0:
        return False, (packet_check.stderr.strip() or "packet validation failed")[:600]

    offsets = [0.0]
    if duration > 16:
        offsets += [max(duration / 2 - 3, 0), max(duration - 6, 0)]
    elif duration > 7:
        offsets += [max(duration - 5, 0)]
    for offset in sorted(set(round(value, 3) for value in offsets)):
        command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode"]
        if offset > 0:
            command += ["-ss", f"{offset:.3f}"]
        command += ["-i", str(path), "-t", "5", "-map", "0:v?", "-map", "0:a?", "-f", "null", "-"]
        sample = run(command, check=False)
        if sample.returncode != 0:
            return False, (sample.stderr.strip() or f"decode sample failed at {offset}s")[:600]
    return True, f"valid {duration:.3f}s container with audio/video"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=Path("docs/tests/phase15-media-smoke.json"))
    parser.add_argument("--keep-fixtures", action="store_true")
    args = parser.parse_args()

    for binary in ("ffmpeg", "ffprobe"):
        if shutil.which(binary) is None:
            raise SystemExit(f"Missing required binary: {binary}")

    temp_context = tempfile.TemporaryDirectory(prefix="cacatools-phase15-")
    work = Path(temp_context.name)
    valid = work / "valid-12s.mp4"
    short = work / "short-2s.mp4"
    corrupt = work / "truncated.mp4"

    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
        "-t", "12", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", str(valid),
    ])
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(valid), "-t", "2", "-c", "copy", str(short)])
    data = valid.read_bytes()
    corrupt.write_bytes(data[: len(data) // 2])

    cases = [
        ("valid", valid, True),
        ("too_short", short, False),
        ("physically_truncated", corrupt, False),
    ]
    results = []
    passed = True
    for name, path, expected_acceptance in cases:
        accepted, detail = validate(path, expected_duration=12.0)
        case_passed = accepted == expected_acceptance
        passed &= case_passed
        results.append({
            "case": name,
            "bytes": path.stat().st_size,
            "expectedAccepted": expected_acceptance,
            "accepted": accepted,
            "passed": case_passed,
            "detail": detail,
        })

    report = {
        "suite": "CacaTools Phase 15 media integrity",
        "passed": passed,
        "ffmpeg": run(["ffmpeg", "-version"]).stdout.splitlines()[0],
        "ffprobe": run(["ffprobe", "-version"]).stdout.splitlines()[0],
        "cases": results,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if args.keep_fixtures:
        destination = args.report.parent / "media-fixtures"
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(work, destination)
    temp_context.cleanup()
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
