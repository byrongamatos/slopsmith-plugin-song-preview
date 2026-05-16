from __future__ import annotations

import asyncio
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

# server.py normally puts lib/ on the path; this is just for direct/reloaded use.
_LIB = Path(__file__).resolve().parents[2] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

_context: dict = {}
_cache_dir: Path | None = None

# One lock per cache key so concurrent requests for the same file don't both transcode.
_transcode_locks: dict[str, threading.Lock] = {}
_locks_mutex = threading.Lock()


def _get_cache_dir() -> Path:
    global _cache_dir
    if _cache_dir is not None:
        return _cache_dir
    config_dir = _context.get("config_dir") or os.environ.get("CONFIG_DIR", "")
    base = Path(config_dir) if config_dir else Path(tempfile.gettempdir())
    _cache_dir = base / "song_preview_cache"
    _cache_dir.mkdir(parents=True, exist_ok=True)
    return _cache_dir


def _transcode_lock(key: str) -> threading.Lock:
    with _locks_mutex:
        if key not in _transcode_locks:
            _transcode_locks[key] = threading.Lock()
        return _transcode_locks[key]


def _wem_data_to_ogg(wem_data: bytes, out_ogg: Path) -> None:
    """WEM bytes -> OGG via vgmstream then ffmpeg."""
    from audio import _vgmstream_cmd, _ffmpeg_cmd  # noqa: PLC0415
    vgmstream = _vgmstream_cmd()
    ffmpeg = _ffmpeg_cmd()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        wem = tmp_path / "audio.wem"
        wav = tmp_path / "audio.wav"
        wem.write_bytes(wem_data)
        # vgmstream handles the proprietary WEM decode; ffmpeg just does the OGG encode.
        result = subprocess.run(
            [vgmstream, "-o", str(wav), str(wem)],
            capture_output=True,
        )
        if result.returncode != 0 or not wav.exists() or wav.stat().st_size < 100:
            raise RuntimeError(
                f"vgmstream-cli failed (rc={result.returncode}): "
                f"{result.stderr.decode(errors='replace')[:200]}"
            )
        result = subprocess.run(
            [ffmpeg, "-y", "-i", str(wav), "-c:a", "libvorbis", "-q:a", "3", str(out_ogg)],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg failed (rc={result.returncode}): "
                f"{result.stderr.decode(errors='replace')[:200]}"
            )


def _psarc_preview_ogg(psarc_path: Path) -> Path:
    """Transcode the preview WEM out of a PSARC and cache the resulting OGG.

    Rocksmith PSARCs store audio as WEMs named by numeric Wwise ID
    (e.g. audio/windows/156630708.wem), so we can't pick the preview by
    filename. The preview clip is always much smaller than the full-song
    WEM, so the smallest entry wins.
    """
    cache_key = hashlib.sha256(("v4:" + str(psarc_path)).encode()).hexdigest()[:20]
    out = _get_cache_dir() / f"{cache_key}.ogg"
    lock = _transcode_lock(cache_key)
    with lock:
        if out.exists() and out.stat().st_size > 1000:
            return out

        from psarc import read_psarc_entries  # noqa: PLC0415
        try:
            wems = read_psarc_entries(psarc_path, ["*.wem"])
            if wems:
                chosen = min(wems.keys(), key=lambda n: len(wems[n]))
                _wem_data_to_ogg(wems[chosen], out)
                return out
        except Exception as e:
            print(f"[song_preview] read_psarc_entries failed ({e}), falling back to unpack")

        # Last resort: full unpack.
        from psarc import unpack_psarc  # noqa: PLC0415
        with tempfile.TemporaryDirectory() as tmp:
            unpack_psarc(psarc_path, Path(tmp))
            wem_files = sorted(Path(tmp).rglob("*.wem"), key=lambda p: p.stat().st_size)
            if not wem_files:
                raise HTTPException(status_code=404, detail="No audio found in PSARC")
            _wem_data_to_ogg(wem_files[0].read_bytes(), out)

    return out


def _loose_preview_ogg(folder: Path) -> Path:
    cache_key = hashlib.sha256(("v4:" + str(folder)).encode()).hexdigest()[:20]
    out = _get_cache_dir() / f"{cache_key}.ogg"
    lock = _transcode_lock(cache_key)
    with lock:
        if out.exists() and out.stat().st_size > 1000:
            return out
        # Smallest WEM is the preview clip; larger ones are full-song stems.
        wems = sorted(folder.rglob("*.wem"), key=lambda p: p.stat().st_size)
        if not wems:
            raise HTTPException(status_code=404, detail="No audio found in loose folder")
        _wem_data_to_ogg(wems[0].read_bytes(), out)
    return out


def _range_response(path: Path, request: Request) -> StreamingResponse:
    """Stream the file with HTTP range support so <audio> can seek."""
    file_size = path.stat().st_size
    range_header = request.headers.get("range", "")
    match = re.match(r"bytes=(\d*)-(\d*)", range_header)

    if match:
        start = int(match.group(1) or 0)
        end = int(match.group(2)) if match.group(2) else file_size - 1
        end = min(end, file_size - 1)
        length = end - start + 1

        def _iter_range():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            _iter_range(),
            status_code=206,
            media_type="audio/ogg",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(length),
                "Accept-Ranges": "bytes",
            },
        )

    def _iter_full():
        with open(path, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        _iter_full(),
        media_type="audio/ogg",
        headers={
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes",
        },
    )


def setup(app: FastAPI, context: dict) -> None:
    global _context
    _context = context

    @app.get("/api/plugins/song_preview/audio")
    async def get_audio(file: str, request: Request):
        if not file:
            raise HTTPException(status_code=400, detail="file parameter required")

        # Reject anything that smells like traversal before we touch disk.
        try:
            p = Path(file)
            if p.is_absolute() or any(part == ".." for part in p.parts):
                raise ValueError("path traversal")
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid file path")

        get_dlc = _context.get("get_dlc_dir")
        if not callable(get_dlc):
            raise HTTPException(status_code=503, detail="DLC folder not configured")
        dlc_root = Path(get_dlc())

        # Belt-and-braces: even after resolving symlinks, stay inside the DLC root.
        full = (dlc_root / file).resolve()
        try:
            full.relative_to(dlc_root.resolve())
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid file path")

        if not full.exists():
            raise HTTPException(status_code=404, detail="file not found")

        file_lower = file.lower()
        try:
            if file_lower.endswith(".psarc"):
                ogg = await asyncio.get_event_loop().run_in_executor(
                    None, _psarc_preview_ogg, full
                )
            elif full.is_dir():
                ogg = await asyncio.get_event_loop().run_in_executor(
                    None, _loose_preview_ogg, full
                )
            else:
                raise HTTPException(status_code=400, detail="unsupported file format")
        except HTTPException:
            raise
        except Exception as e:
            print(f"[song_preview] audio preparation failed for {file!r}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

        return _range_response(ogg, request)