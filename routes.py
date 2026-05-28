from __future__ import annotations

import asyncio
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import threading
import zipfile
import yaml
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

# server.py normally puts lib/ on the path; this is just for direct/reloaded use.
_LIB = Path(__file__).resolve().parents[2] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

_context: dict = {}
_cache_dir: Path | None = None

# One lock per cache key so concurrent requests for the same file don't both transcode.
_transcode_locks: dict[str, threading.Lock] = {}
_locks_mutex = threading.Lock()

# Cap the OGG cache. Without this, the directory grows one file per song forever.
_CACHE_MAX_BYTES = 256 * 1024 * 1024


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


def _evict_cache(max_bytes: int = _CACHE_MAX_BYTES) -> None:
    """Bound the OGG cache by deleting the oldest entries until under max_bytes."""
    try:
        entries: list[tuple[float, int, Path]] = []
        total = 0
        for p in _get_cache_dir().glob("*.ogg"):
            try:
                st = p.stat()
            except OSError:
                continue
            entries.append((st.st_mtime, st.st_size, p))
            total += st.st_size
        if total <= max_bytes:
            return
        entries.sort(key=lambda e: e[0])
        for _, size, p in entries:
            if total <= max_bytes:
                break
            try:
                p.unlink()
                total -= size
            except OSError:
                pass
    except Exception as e:
        print(f"[song_preview] cache eviction failed: {e}")


def _touch_cache_entry(path: Path) -> None:
    # Bumps mtime so LRU eviction keeps the recently-used entries.
    try:
        os.utime(path, None)
    except OSError:
        pass


def _wem_data_to_ogg(wem_data: bytes, out_ogg: Path) -> None:
    """WEM bytes -> OGG via vgmstream then ffmpeg."""
    from audio import _vgmstream_cmd, _ffmpeg_cmd  # noqa: PLC0415
    vgmstream = _vgmstream_cmd()
    ffmpeg = _ffmpeg_cmd()
    # Both resolvers return None when the tool isn't on PATH. Without this
    # guard, subprocess.run([None, ...]) raises a confusing TypeError that
    # surfaces as a generic 500.
    if vgmstream is None or ffmpeg is None:
        missing = ", ".join(
            name
            for name, cmd in (("vgmstream-cli", vgmstream), ("ffmpeg", ffmpeg))
            if cmd is None
        )
        raise HTTPException(
            status_code=503,
            detail=f"audio decoder unavailable ({missing} not found on PATH)",
        )
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
            _touch_cache_entry(out)
            return out

        from psarc import read_psarc_entries  # noqa: PLC0415
        try:
            wems = read_psarc_entries(psarc_path, ["*.wem"])
            if wems:
                chosen = min(wems.keys(), key=lambda n: len(wems[n]))
                _wem_data_to_ogg(wems[chosen], out)
                _evict_cache()
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
            _evict_cache()

    return out


def _loose_preview_ogg(folder: Path) -> Path:
    cache_key = hashlib.sha256(("v4:" + str(folder)).encode()).hexdigest()[:20]
    out = _get_cache_dir() / f"{cache_key}.ogg"
    lock = _transcode_lock(cache_key)
    with lock:
        if out.exists() and out.stat().st_size > 1000:
            _touch_cache_entry(out)
            return out
        # Smallest WEM is the preview clip; larger ones are full-song stems.
        wems = sorted(folder.rglob("*.wem"), key=lambda p: p.stat().st_size)
        if not wems:
            raise HTTPException(status_code=404, detail="No audio found in loose folder")
        _wem_data_to_ogg(wems[0].read_bytes(), out)
        _evict_cache()
    return out

def _read_sloppak_preview(sloppak_path: Path) -> bytes | None:
    """Return the raw bytes of the embedded preview clip from a sloppak, or
    None if the sloppak doesn't declare one.

    Sloppaks produced by `sloppak_converter` >= the preview-embed branch
    carry the original PSARC preview WEM (transcoded to OGG) as
    `preview.ogg` at sloppak root, referenced via a top-level `preview:`
    field in manifest.yaml. Older / hand-authored sloppaks without that
    field return None and the caller surfaces a 404 — there's no sensible
    auto-fallback because the split stems are full-length, so picking
    "the smallest stem" would land on a 4-minute drum track, not a
    20-second preview clip.

    Handles both sloppak forms: zip-archive (the converter's default
    output) and on-disk directory (the authoring shape).
    """
    if sloppak_path.is_dir():
        for candidate in ("manifest.yaml", "manifest.yml"):
            mf = sloppak_path / candidate
            if mf.exists():
                break
        else:
            return None
        try:
            manifest = yaml.safe_load(mf.read_text(encoding="utf-8")) or {}
        except Exception as e:
            print(f"[song_preview] failed to parse sloppak manifest {mf}: {e}")
            return None
        rel = manifest.get("preview")
        if not isinstance(rel, str) or not rel:
            return None
        # Defence against `preview: ../foo` in a hand-edited manifest —
        # we'd otherwise read arbitrary files relative to the sloppak.
        rel_p = Path(rel)
        if rel_p.is_absolute() or any(p == ".." for p in rel_p.parts):
            return None
        target = sloppak_path / rel_p
        if not target.is_file():
            return None
        return target.read_bytes()

    # Zip form. Open once and pull both manifest + preview without ever
    # extracting to disk — preview clips are tens of KB to ~MB at most,
    # so an in-memory round-trip is cheaper than the zipfile setup cost
    # of doing it twice.
    try:
        with zipfile.ZipFile(str(sloppak_path), "r") as zf:
            names = set(zf.namelist())
            mf_name = next(
                (n for n in ("manifest.yaml", "manifest.yml") if n in names),
                None,
            )
            if mf_name is None:
                return None
            with zf.open(mf_name) as f:
                manifest = yaml.safe_load(f.read().decode("utf-8")) or {}
            rel = manifest.get("preview")
            if not isinstance(rel, str) or not rel:
                return None
            rel_p = Path(rel)
            if rel_p.is_absolute() or any(p == ".." for p in rel_p.parts):
                return None
            # zipfile uses forward-slash internal paths regardless of OS.
            zip_rel = rel.replace("\\", "/")
            try:
                with zf.open(zip_rel) as f:
                    return f.read()
            except KeyError:
                return None
    except (zipfile.BadZipFile, OSError) as e:
        print(f"[song_preview] failed to read sloppak {sloppak_path.name}: {e}")
        return None


def _sloppak_preview_ogg(sloppak_path: Path) -> Path:
    """Extract a sloppak's embedded preview OGG into the on-disk cache and
    return the cached path.

    Unlike `_psarc_preview_ogg`, no transcoding is needed — sloppaks store
    the preview as OGG already (the sloppak_converter did the WEM → OGG
    step at convert time). We still materialise to disk because
    `_range_response` streams from a file path so HTTP byte-range seeks
    work — without that the `<audio>` element can't scrub.

    Cache key includes mtime+size: a re-converted sloppak overwrites the
    same path with new preview bytes, and a path-only key (the shape
    `_psarc_preview_ogg` uses) would serve stale audio. PSARCs don't
    have this problem because they're authored externally and rarely
    change in place.
    """
    stat = sloppak_path.stat()
    key_input = f"v1-sloppak:{sloppak_path}:{stat.st_mtime}:{stat.st_size}"
    cache_key = hashlib.sha256(key_input.encode()).hexdigest()[:20]
    out = _get_cache_dir() / f"{cache_key}.ogg"
    lock = _transcode_lock(cache_key)
    with lock:
        if out.exists() and out.stat().st_size > 1000:
            return out

        data = _read_sloppak_preview(sloppak_path)
        if not data:
            raise HTTPException(
                status_code=404,
                detail="sloppak has no embedded preview clip "
                       "(re-convert with the latest sloppak_converter to backfill)",
            )
        # Atomic write so a partial-write crash doesn't pollute the cache
        # with a truncated OGG the size-check above would still accept on
        # the next request.
        tmp = out.with_suffix(out.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(out)
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

    @app.get("/api/plugins/song_preview/js/{filename}")
    def get_js(filename: str, request: Request):
        """Serve modular JS class files from ./js/.

        The host's plugin loader exposes exactly one URL per plugin (the
        manifest's `script` field). To split screen.js across multiple
        classes we have to be our own static-file server for the rest.
        Locked down to bare `.js` filenames inside the js/ subdir — no
        traversal, no other extensions.

        Strong ETag + `must-revalidate` so the browser always asks but
        gets a 304 (no body) when the file is unchanged. Cheaper than
        re-shipping the body on every plugin reload, and doesn't break
        the dev cycle the way a long `max-age` would.
        """
        if not filename.endswith(".js") or "/" in filename \
                or "\\" in filename or filename.startswith("."):
            raise HTTPException(status_code=400, detail="invalid filename")
        js_dir = (Path(__file__).resolve().parent / "js").resolve()
        target = (js_dir / filename).resolve()
        try:
            target.relative_to(js_dir)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid filename")
        if not target.is_file():
            raise HTTPException(status_code=404, detail="not found")
        body = target.read_bytes()
        etag = '"' + hashlib.sha256(body).hexdigest()[:16] + '"'
        cache_headers = {
            "ETag": etag,
            "Cache-Control": "public, max-age=0, must-revalidate",
        }
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=cache_headers)
        return Response(
            content=body,
            media_type="application/javascript",
            headers=cache_headers,
        )

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
            elif file_lower.endswith(".sloppak"):
                # Covers both forms: zip-file `.sloppak` and directory-form
                # `.sloppak/`. The extension check MUST come before the
                # generic `is_dir()` branch below — otherwise a sloppak
                # directory would be misrouted into the loose-folder WEM
                # scanner, which finds nothing and 404s for the wrong
                # reason.
                ogg = await asyncio.get_event_loop().run_in_executor(
                    None, _sloppak_preview_ogg, full
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
            # Keep the detail in server logs; don't echo raw exception text to the client.
            print(f"[song_preview] audio preparation failed for {file!r}: {e}")
            raise HTTPException(status_code=500, detail="audio preparation failed")

        return _range_response(ogg, request)