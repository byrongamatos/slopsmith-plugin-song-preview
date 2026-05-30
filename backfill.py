"""Preview backfill for sloppaks lacking a `preview:` clip.

Authoring history: pre-preview-embed sloppak_converter builds, hand-rolled
sloppaks, and externally-shared sloppaks may all lack the `preview.ogg`
that the song-preview hover effect needs. This module finds them, pairs
them against a same-basename PSARC where one exists, and injects the
PSARC's Wwise-baked preview WEM (transcoded to OGG) into the sloppak.

Two sloppak forms are handled symmetrically (dir + zip). Writes are
atomic — a kill mid-injection leaves the original sloppak untouched.
"""

from __future__ import annotations

import concurrent.futures
import json
import logging
import os
import re
import subprocess
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

import yaml

log = logging.getLogger("slopsmith.plugin.song_preview.backfill")

# Filename the injected preview lives under inside the sloppak. Matches
# what sloppak_convert.py writes for fresh PSARC→sloppak conversions, so
# the manifest's `preview:` key value is stable across both code paths.
PREVIEW_REL = "preview.ogg"


def _resolve_within(base: Path, rel: str) -> Path | None:
    """Join ``base / rel`` and return it only if the result stays inside
    ``base`` after resolving symlinks; otherwise ``None``.

    Manifests live inside user-supplied sloppaks, so every relative path they
    declare (stems, arrangements, lyrics, preview) is untrusted input.
    Rejecting absolute paths and ``..`` stops classic traversal; the
    resolve()+relative_to() check additionally stops a symlink *inside* the
    sloppak from pointing at a file *outside* it — without it, a crafted
    sloppak could read arbitrary host files through the preview/backfill
    pipeline.
    """
    if not isinstance(rel, str) or not rel:
        return None
    rp = Path(rel)
    if rp.is_absolute() or any(part == ".." for part in rp.parts):
        return None
    try:
        base_resolved = base.resolve()
        target = (base_resolved / rp).resolve()
        target.relative_to(base_resolved)
    except (OSError, ValueError):
        return None
    return target


# ── Discovery ────────────────────────────────────────────────────────────────

# Folder names whose contents are excluded from the audit entirely. These hold
# built-in content the user didn't add and shouldn't be asked to "fix" — e.g.
# the bundled tutorial songs under `tutorials-builtin/`. Matched case-
# insensitively against every path component, so a sloppak at any depth under
# such a folder is skipped. Add more names here as other built-in dirs appear.
_IGNORED_DIR_NAMES = {"tutorials-builtin"}


def _iter_sloppaks(dlc_root: Path) -> Iterable[Path]:
    """Yield every sloppak under ``dlc_root`` (zip files and dir-form),
    skipping anything inside an ignored built-in folder."""
    if not dlc_root.is_dir():
        return
    for entry in dlc_root.rglob("*.sloppak"):
        # Skip our own unpack cache + any other staging dirs that might
        # appear as siblings — only the user-visible DLC dir matters.
        # We rely on the rglob result being only paths whose terminal
        # component literally ends in `.sloppak`; both zip-file and
        # directory forms qualify.
        try:
            parts = entry.relative_to(dlc_root).parts
        except ValueError:
            parts = entry.parts
        if any(part.lower() in _IGNORED_DIR_NAMES for part in parts):
            continue
        yield entry


def _read_manifest_quick(sloppak_path: Path) -> dict | None:
    """Parse manifest.yaml from a sloppak (dir or zip) without unpacking.

    Returns None on any read/parse failure — callers treat that as
    "not eligible for backfill", same as a sloppak without a preview.
    """
    try:
        if sloppak_path.is_dir():
            for cand in ("manifest.yaml", "manifest.yml"):
                mf = sloppak_path / cand
                if mf.is_file():
                    return yaml.safe_load(mf.read_text(encoding="utf-8")) or {}
            return None
        with zipfile.ZipFile(str(sloppak_path), "r") as zf:
            names = set(zf.namelist())
            mf_name = next(
                (n for n in ("manifest.yaml", "manifest.yml") if n in names),
                None,
            )
            if mf_name is None:
                return None
            with zf.open(mf_name) as f:
                return yaml.safe_load(f.read().decode("utf-8")) or {}
    except (OSError, zipfile.BadZipFile, yaml.YAMLError) as e:
        log.debug("manifest read failed for %s: %s", sloppak_path, e)
        return None


def _has_preview(sloppak_path: Path, manifest: dict) -> bool:
    """True if the sloppak's manifest declares a preview AND the file exists."""
    rel = manifest.get("preview")
    if not isinstance(rel, str) or not rel:
        return False
    # Defence against traversal in a hand-edited manifest. A preview
    # pointing outside the sloppak isn't "present" — treat as missing
    # so the backfill overwrites it with a safe path.
    rel_p = Path(rel)
    if rel_p.is_absolute() or any(p == ".." for p in rel_p.parts):
        return False
    if sloppak_path.is_dir():
        target = sloppak_path / rel_p
        return target.is_file() and target.stat().st_size > 100
    try:
        with zipfile.ZipFile(str(sloppak_path), "r") as zf:
            # zipfile uses forward-slash internal names regardless of OS.
            try:
                info = zf.getinfo(rel.replace("\\", "/"))
            except KeyError:
                return False
            return info.file_size > 100
    except (OSError, zipfile.BadZipFile):
        return False


def _find_paired_psarc(sloppak_path: Path, dlc_root: Path) -> Path | None:
    """Return the same-basename `.psarc` for ``sloppak_path`` if one exists
    anywhere between the sloppak's parent dir and the DLC root (inclusive).

    Sloppaks are often organised into a subfolder (`dlc/sloppak/Foo.sloppak`)
    while the original PSARC sits at the DLC root (`dlc/Foo.psarc`). A
    sibling-only check misses that common layout. Walking up to (and
    including) the DLC root catches both:

      dlc/Foo.psarc + dlc/Foo.sloppak                      ← immediate sibling
      dlc/Foo.psarc + dlc/sloppak/Foo.sloppak              ← parent dir
      dlc/Foo.psarc + dlc/sloppak/by-artist/Foo.sloppak    ← deeper subtree

    The walk is bounded to the DLC root (we never escape upwards), so the
    cost is O(depth) — typically 1-3 stats per sloppak.
    """
    name = sloppak_path.name
    # Strip the `.sloppak` suffix case-insensitively — Path.stem would
    # also work for the file form, but for directory-form sloppaks
    # (`Foo.sloppak/`) `stem` returns `Foo` only because the trailing
    # `.sloppak` is treated as a suffix; safer to do it manually so a
    # mixed-case `.SLOPPAK` doesn't fall through.
    lower = name.lower()
    if not lower.endswith(".sloppak"):
        return None
    base = name[: -len(".sloppak")]

    # Candidate PSARC filenames, tried in order. The sloppak_converter
    # strips Rocksmith's platform suffixes when naming its output
    # (`311allm_p.psarc` → `311allm.sloppak`), so the reverse lookup
    # has to try them back on. `_p` (PC) is by far the most common
    # source; `_m` is Mac. Other platform suffixes (`_ps3`, `_xbox360`)
    # exist but the converter doesn't strip them, so we don't need to
    # re-add them either.
    candidate_names = [
        f"{base}.psarc",        # exact basename match (rare — would mean PSARC was renamed)
        f"{base}_p.psarc",      # Windows PSARC (typical case)
        f"{base}_m.psarc",      # Mac PSARC
    ]

    try:
        dlc_resolved = dlc_root.resolve()
    except OSError:
        return None

    current = sloppak_path.parent
    # Cap the walk at a sensible depth so a misconfiguration (sloppak
    # below an unrelated dlc_root) can't take us climbing /forever.
    for _ in range(16):
        for cand_name in candidate_names:
            candidate = current / cand_name
            if candidate.is_file():
                return candidate
        # Stop when we've checked the DLC root itself.
        try:
            current_resolved = current.resolve()
        except OSError:
            return None
        if current_resolved == dlc_resolved:
            return None
        parent = current.parent
        if parent == current:  # filesystem root reached
            return None
        current = parent
    return None


@dataclass
class MissingEntry:
    filename: str               # relpath under DLC root, what the API expects
    has_paired_psarc: bool      # backfill viable via PSARC pairing
    format: str                 # "zip" or "dir" — surfaced for UI hinting
    title: str = ""             # from manifest.yaml, falls back to filename stem
    artist: str = ""            # from manifest.yaml, may be empty


def _entry_title_fallback(filename: str) -> str:
    """Strip the relpath down to a basename without the .sloppak suffix.
    Used when the manifest's title is missing/blank so UI rows always
    have *something* human-ish to display."""
    base = filename.rsplit("/", 1)[-1]
    if base.lower().endswith(".sloppak"):
        base = base[: -len(".sloppak")]
    return base


def audit(dlc_root: Path) -> list[MissingEntry]:
    """Walk the DLC root and return every sloppak missing a usable preview.

    Returned entries carry title + artist pulled from each sloppak's
    manifest so the UI can render proper "Song Title — Artist" rows
    without a follow-up library API round-trip per song.
    """
    out: list[MissingEntry] = []
    for sloppak in _iter_sloppaks(dlc_root):
        manifest = _read_manifest_quick(sloppak)
        if manifest is None:
            # Unreadable manifest — not actionable; skip to keep the
            # "missing" list strictly about previews, not corruption.
            continue
        if _has_preview(sloppak, manifest):
            continue
        try:
            rel = sloppak.relative_to(dlc_root).as_posix()
        except ValueError:
            # Shouldn't happen — rglob returns descendants — but if it
            # does, the audit row would be unusable by the API anyway.
            continue
        title = str(manifest.get("title") or "").strip() or _entry_title_fallback(rel)
        artist = str(manifest.get("artist") or "").strip()
        out.append(MissingEntry(
            filename=rel,
            has_paired_psarc=_find_paired_psarc(sloppak, dlc_root) is not None,
            format="dir" if sloppak.is_dir() else "zip",
            title=title,
            artist=artist,
        ))
    return out


# ── PSARC → preview OGG bytes ────────────────────────────────────────────────

def extract_preview_ogg_from_psarc(
    psarc_path: Path,
    wem_to_ogg: Callable[[bytes, Path], None],
    tmp_dir: Path,
) -> bytes:
    """Pick the preview WEM out of ``psarc_path`` and return OGG bytes.

    Reuses the caller-supplied ``wem_to_ogg`` (the plugin's
    `_wem_data_to_ogg`) so vgmstream/ffmpeg discovery and error handling
    stay in one place.

    Selection: PSARCs name WEMs by Wwise GUID, so we can't pick by name.
    Smallest WEM wins — the preview is always the short clip; the other
    WEMs (one or more) carry the full song.
    """
    from psarc import read_psarc_entries  # noqa: PLC0415

    try:
        wems = read_psarc_entries(psarc_path, ["*.wem"])
    except Exception as e:
        # Surface as a clean error to the caller; this is a routine
        # failure mode for malformed / partial PSARCs.
        raise RuntimeError(f"failed to read PSARC entries: {e}") from e

    if not wems:
        raise RuntimeError("PSARC contains no WEM audio")
    if len(wems) < 2:
        # Single-WEM PSARC = full-song only, no preview baked in.
        # Lifting the full song as "preview" would dump a 4-minute clip,
        # so refuse — the no-PSARC fallback (trim + fade) will own this
        # case once it ships.
        raise RuntimeError("PSARC has only one WEM (no preview clip baked in)")

    chosen = min(wems.keys(), key=lambda n: len(wems[n]))
    out_ogg = tmp_dir / "preview.ogg"
    wem_to_ogg(wems[chosen], out_ogg)
    return out_ogg.read_bytes()


# ── Injection (atomic) ───────────────────────────────────────────────────────

def _dump_manifest(manifest: dict) -> str:
    return yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True)


def _inject_dir_form(sloppak_dir: Path, ogg_bytes: bytes) -> None:
    """Write preview.ogg + updated manifest.yaml into a dir-form sloppak.

    Both writes go via `.tmp` siblings + atomic rename so a kill in the
    middle leaves the sloppak in its previous-valid state. The order
    matters: write the new preview first so the manifest pointer is
    never live before the file exists.
    """
    for cand in ("manifest.yaml", "manifest.yml"):
        mf = sloppak_dir / cand
        if mf.is_file():
            mf_path = mf
            break
    else:
        raise RuntimeError(f"manifest.yaml not found in {sloppak_dir}")

    manifest = yaml.safe_load(mf_path.read_text(encoding="utf-8")) or {}

    preview_path = sloppak_dir / PREVIEW_REL
    preview_tmp = preview_path.with_suffix(preview_path.suffix + ".tmp")
    mf_tmp = mf_path.with_suffix(mf_path.suffix + ".tmp")
    try:
        preview_tmp.write_bytes(ogg_bytes)
        preview_tmp.replace(preview_path)

        manifest["preview"] = PREVIEW_REL
        mf_tmp.write_text(_dump_manifest(manifest), encoding="utf-8")
        mf_tmp.replace(mf_path)
    finally:
        # A successful replace renames the .tmp away, so these are no-ops on
        # the happy path; on a mid-write failure they stop a stale .tmp from
        # lingering inside the user's sloppak directory.
        for leftover in (preview_tmp, mf_tmp):
            try:
                if leftover.exists():
                    leftover.unlink()
            except OSError:
                pass


def _inject_zip_form(sloppak_zip: Path, ogg_bytes: bytes) -> None:
    """Rebuild the sloppak zip with the injected preview.

    Repacking is necessary because the stdlib `zipfile` module can't
    rewrite a single member in place. Strategy: stream every member
    except the manifest (which we're updating) and any existing
    `preview.ogg` (which we're replacing) into a `.tmp` zip next to the
    original, append the new preview + updated manifest, then
    `os.replace` onto the original. Matches the pattern in
    `lib/sloppak_convert.split_sloppak_stems` so the host's sloppak
    source cache (keyed on mtime+size) invalidates naturally.
    """
    tmp_out = sloppak_zip.with_suffix(sloppak_zip.suffix + ".tmp")
    # Clean stale tmp from a prior killed run so we don't accidentally
    # write into a half-baked zip.
    if tmp_out.exists():
        tmp_out.unlink()

    manifest_name: str | None = None
    manifest: dict = {}

    try:
        with zipfile.ZipFile(str(sloppak_zip), "r") as zin:
            names = zin.namelist()
            manifest_name = next(
                (n for n in ("manifest.yaml", "manifest.yml") if n in names),
                None,
            )
            if manifest_name is None:
                raise RuntimeError("sloppak has no manifest.yaml")
            with zin.open(manifest_name) as f:
                manifest = yaml.safe_load(f.read().decode("utf-8")) or {}

            with zipfile.ZipFile(str(tmp_out), "w", zipfile.ZIP_DEFLATED) as zout:
                # Forward-slash normalisation matches zipfile's internal
                # representation; comparisons must use the same form.
                preview_zip_name = PREVIEW_REL.replace("\\", "/")
                for info in zin.infolist():
                    if info.filename == manifest_name:
                        continue
                    if info.filename.replace("\\", "/") == preview_zip_name:
                        continue
                    # Stream-copy the raw member; avoids decompress/recompress.
                    with zin.open(info) as src:
                        zout.writestr(info, src.read())

                manifest["preview"] = PREVIEW_REL
                # Use ZipInfo so we control filename casing exactly — a
                # bare writestr(str, bytes) would also work, but going
                # through ZipInfo keeps the timestamp explicit (zipfile's
                # epoch default is 1980 on some platforms).
                preview_info = zipfile.ZipInfo(preview_zip_name)
                preview_info.compress_type = zipfile.ZIP_DEFLATED
                # OGG is already compressed — compression level is
                # mostly cosmetic here. Use the default level rather
                # than ZIP_STORED so the file at least claims DEFLATE
                # alongside its siblings (some readers warn on mixed).
                zout.writestr(preview_info, ogg_bytes)

                manifest_info = zipfile.ZipInfo(manifest_name)
                manifest_info.compress_type = zipfile.ZIP_DEFLATED
                zout.writestr(manifest_info, _dump_manifest(manifest))

        # Atomic file swap. On Windows `os.replace` handles the
        # destination-exists case across the file-on-file path.
        os.replace(tmp_out, sloppak_zip)
    except Exception:
        # Don't leave a half-written `.tmp` lying around for the next run
        # to mistake for an in-flight job.
        if tmp_out.exists():
            try:
                tmp_out.unlink()
            except OSError:
                pass
        raise


def inject_preview(sloppak_path: Path, ogg_bytes: bytes) -> None:
    """Inject ``ogg_bytes`` as the sloppak's preview, updating its manifest."""
    if not ogg_bytes or len(ogg_bytes) < 200:
        # Don't even start if the bytes look truncated; the host cache
        # check is `> 1000` but its threshold is for OGG playable size
        # rather than a sanity floor, so be stricter here.
        raise RuntimeError("refusing to inject suspiciously small OGG payload")
    if sloppak_path.is_dir():
        _inject_dir_form(sloppak_path, ogg_bytes)
    else:
        _inject_zip_form(sloppak_path, ogg_bytes)


# ── No-PSARC fallback: trim + fade the sloppak's own full audio ─────────────

# Calibrated against `2minutes_p.psarc` (a representative Rocksmith DLC):
# the Wwise-baked preview is exactly 28.000s with ~1s linear fades on each
# end. Encoding matches `sloppak_convert._wem_to_ogg` (libvorbis q:3) so
# the fallback output is byte-shaped like a converter-emitted preview.
# We bump to 30s as the standard generated length because it's the round
# number people associate with music-discovery previews (Spotify / Apple)
# and the 2s delta isn't audibly meaningful.
FALLBACK_PREVIEW_DURATION = 30.0
FALLBACK_FADE_IN = 1.0
FALLBACK_FADE_OUT = 1.0
FINAL_FALLBACK_OFFSET_FRAC = 0.25  # the floor of the resolver chain
# Land the preview start a beat or two before the first vocal so the listener
# hears a brief lead-in rather than a vocal entering cold. 2s matches what
# Wwise's hand-curated previews tend to do (see 2minutes_p.psarc analysis).
LYRICS_LEAD_IN_SECONDS = 2.0
# A song shorter than this can't carry a meaningful preview (clip + fades
# would consume the whole track). Refusing rather than producing a
# 5-second clip keeps the UX honest.
MIN_SONG_DURATION = FALLBACK_PREVIEW_DURATION + FALLBACK_FADE_IN + FALLBACK_FADE_OUT + 1.0

# Section names that are NEVER an interesting preview start. Used by the
# section-aware resolver as a hard-skip list. Solo/Bridge/Breakdown are
# allowed (they're often the highlight of instrumental tracks, and the
# lyrics-first branch already runs ahead of section-aware so on vocal
# tracks the user gets vocals regardless).
_BORING_SECTION_RE = re.compile(
    r"intro|outro|silence|nogu|no_gu|fadeout",
    re.IGNORECASE,
)


def _read_manifest_text(
    sloppak_path: Path,
) -> tuple[dict, dict[str, bytes], bytes | None]:
    """Return (manifest_dict, arrangement_json_blobs, lyrics_blob_or_None).

    One-pass read of everything the no-PSARC fallback needs: the
    manifest, each arrangement JSON the manifest references (for
    section lookup), and the lyrics JSON if the manifest declares
    one (for first-vocal lookup). Arrangement and lyrics payloads
    are returned as raw bytes so callers can defer parsing.
    """
    arr_blobs: dict[str, bytes] = {}
    lyrics_blob: bytes | None = None

    if sloppak_path.is_dir():
        for cand in ("manifest.yaml", "manifest.yml"):
            mf = sloppak_path / cand
            if mf.is_file():
                manifest = yaml.safe_load(mf.read_text(encoding="utf-8")) or {}
                break
        else:
            raise RuntimeError("manifest.yaml not found")
        for entry in manifest.get("arrangements", []) or []:
            rel = entry.get("file")
            if not rel:
                continue
            arr_path = _resolve_within(sloppak_path, rel)
            if arr_path and arr_path.is_file():
                arr_blobs[rel] = arr_path.read_bytes()
        lyrics_rel = manifest.get("lyrics")
        if isinstance(lyrics_rel, str) and lyrics_rel:
            lyrics_path = _resolve_within(sloppak_path, lyrics_rel)
            if lyrics_path and lyrics_path.is_file():
                lyrics_blob = lyrics_path.read_bytes()
        return manifest, arr_blobs, lyrics_blob

    with zipfile.ZipFile(str(sloppak_path), "r") as zf:
        names = set(zf.namelist())
        mf_name = next(
            (n for n in ("manifest.yaml", "manifest.yml") if n in names),
            None,
        )
        if mf_name is None:
            raise RuntimeError("manifest.yaml not found in sloppak zip")
        with zf.open(mf_name) as f:
            manifest = yaml.safe_load(f.read().decode("utf-8")) or {}
        for entry in manifest.get("arrangements", []) or []:
            rel = entry.get("file")
            if not rel:
                continue
            zname = rel.replace("\\", "/")
            if zname in names:
                with zf.open(zname) as f:
                    arr_blobs[rel] = f.read()
        lyrics_rel = manifest.get("lyrics")
        if isinstance(lyrics_rel, str) and lyrics_rel:
            zname = lyrics_rel.replace("\\", "/")
            if zname in names:
                with zf.open(zname) as f:
                    lyrics_blob = f.read()
    return manifest, arr_blobs, lyrics_blob


def _find_first_lyric_time(lyrics_blob: bytes | None) -> float | None:
    """First non-empty syllable timestamp from a sloppak lyrics file.

    Sloppak lyrics carry one entry per syllable as ``{w, t, d}`` (word,
    time, duration). Entries with `w` set to `+` (line break) or `-`
    (continuation glue) carry no actual vocal, so we skip them. Returns
    None on empty/invalid lyrics.
    """
    if not lyrics_blob:
        return None
    try:
        data = json.loads(lyrics_blob.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, list):
        return None
    for entry in data:
        if not isinstance(entry, dict):
            continue
        w = str(entry.get("w") or "").strip()
        if not w or w in ("+", "-"):
            continue
        try:
            t = float(entry.get("t", 0.0) or 0.0)
        except (TypeError, ValueError):
            continue
        if t > 0:
            return t
    return None


def _loudness_detect_start(
    audio_path: Path,
    ffmpeg_cmd: str,
    song_duration: float,
) -> float | None:
    """Pick the start of the loudest contiguous ``FALLBACK_PREVIEW_DURATION``
    window via per-second RMS analysis. Returns offset in seconds, or None.

    Decode at 8 kHz mono — well below the Nyquist of anything we care
    about for relative loudness comparison, but small enough to keep the
    decode + analysis cheap (~26 MB → ~2.4 MB of int16 PCM for a
    5-minute song). audioop.rms is the fastest stdlib way to RMS a
    chunk; deprecated in 3.12 and slated for removal in 3.13, so this
    will need to swap to numpy or pure-Python when 3.13 lands. Plugin
    runs in 3.12 today, so we're fine.
    """
    sample_rate = 8000
    cmd = [
        ffmpeg_cmd, "-y",
        "-i", str(audio_path),
        "-ac", "1", "-ar", str(sample_rate), "-f", "s16le",
        "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=120)
    except (subprocess.TimeoutExpired, OSError) as e:
        log.debug("loudness decode failed: %s", e)
        return None
    if r.returncode != 0 or not r.stdout:
        return None
    raw = r.stdout
    samples_per_window = sample_rate  # 1 s
    n_windows = len(raw) // (2 * samples_per_window)
    win_sec = int(FALLBACK_PREVIEW_DURATION)
    if n_windows < win_sec + 1:
        return None
    try:
        import audioop  # noqa: PLC0415
    except ImportError:
        return None
    import warnings  # noqa: PLC0415
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        rms: list[int] = []
        for i in range(n_windows):
            off = i * 2 * samples_per_window
            chunk = raw[off:off + 2 * samples_per_window]
            rms.append(audioop.rms(chunk, 2))
    # Sliding-window sum of RMS over the preview duration. Cumsum keeps
    # this O(N) instead of O(N * win).
    cum = [0]
    for v in rms:
        cum.append(cum[-1] + v)
    # Last legal start: ends at song-1s to preserve the fade-out tail.
    max_start_window = min(
        n_windows - win_sec,
        int(song_duration - FALLBACK_PREVIEW_DURATION - 1.0),
    )
    if max_start_window < 0:
        return None
    best_sum = -1
    best_off = 0
    for i in range(max_start_window + 1):
        s = cum[i + win_sec] - cum[i]
        if s > best_sum:
            best_sum = s
            best_off = i
    return float(best_off)


def _section_aware_start(
    arr_blobs: dict[str, bytes],
    song_duration: float,
) -> tuple[float, str] | None:
    """First section across all arrangements whose name isn't in the
    boring-skip list AND whose start leaves room for the full clip."""
    best: tuple[float, str] | None = None
    for blob in arr_blobs.values():
        try:
            data = json.loads(blob.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        for sec in data.get("sections", []) or []:
            name = str(sec.get("name") or "")
            if not name or _BORING_SECTION_RE.search(name):
                continue
            try:
                t = float(sec.get("time", sec.get("start_time", 0.0)) or 0.0)
            except (TypeError, ValueError):
                continue
            if t <= 0 or t >= song_duration:
                continue
            if t + FALLBACK_PREVIEW_DURATION > song_duration - 0.5:
                continue
            if best is None or t < best[0]:
                best = (t, f"section '{name}'")
    return best


def _clamp_start(start: float, song_duration: float) -> float:
    """Push ``start`` back so the clip + fade-out fits inside the song."""
    latest_safe = max(0.0, song_duration - FALLBACK_PREVIEW_DURATION - 1.0)
    return min(max(0.0, start), latest_safe)


def _resolve_preview_start(
    manifest: dict,
    arr_blobs: dict[str, bytes],
    lyrics_blob: bytes | None,
    song_duration: float,
    audio_path: Path,
    ffmpeg_cmd: str,
) -> tuple[float, str]:
    """Pick where in the song the preview clip should start.

    Chain, in order — first hit wins:
      1. **Lyrics-first**: if the sloppak has a lyrics file, start
         ``LYRICS_LEAD_IN_SECONDS`` before the first non-empty syllable.
         Matches the hand-curated Rocksmith convention (verified
         against `2minutes_p.psarc`).
      2. **Section-aware**: first non-Intro/Outro section across all
         arrangements.
      3. **Loudness-detect**: decode at 8 kHz, slide a 28s window,
         pick the loudest contiguous span. Usually lands on the
         chorus / main riff.
      4. **25% fallback**: when nothing else worked.

    Returns ``(seconds, reason)`` where reason is human-readable
    for the server log so operators can audit what got picked.
    """
    first_lyric = _find_first_lyric_time(lyrics_blob)
    if first_lyric is not None:
        start = _clamp_start(first_lyric - LYRICS_LEAD_IN_SECONDS, song_duration)
        return start, (
            f"lyrics-aligned (first vocal at {first_lyric:.1f}s, "
            f"{LYRICS_LEAD_IN_SECONDS:.1f}s lead-in)"
        )

    section_hit = _section_aware_start(arr_blobs, song_duration)
    if section_hit is not None:
        return section_hit[0], section_hit[1]

    loud_start = _loudness_detect_start(audio_path, ffmpeg_cmd, song_duration)
    if loud_start is not None:
        return _clamp_start(loud_start, song_duration), (
            f"loudness-detected (loudest {int(FALLBACK_PREVIEW_DURATION)}s window)"
        )

    target = song_duration * FINAL_FALLBACK_OFFSET_FRAC
    return _clamp_start(target, song_duration), (
        f"{int(FINAL_FALLBACK_OFFSET_FRAC * 100)}% fallback (no lyrics, sections, or loudness signal)"
    )


def _list_stems(manifest: dict) -> list[str]:
    """Return relative stem file paths declared by the manifest, in
    manifest order. Filters to entries that have a 'file' field."""
    out: list[str] = []
    for entry in manifest.get("stems", []) or []:
        rel = entry.get("file") if isinstance(entry, dict) else None
        if isinstance(rel, str) and rel:
            out.append(rel)
    return out


def _materialise_full_audio(
    sloppak_path: Path,
    manifest: dict,
    tmp_dir: Path,
    ffmpeg_cmd: str,
) -> Path:
    """Produce a single full-mix audio file on disk usable as ffmpeg input.

    Strategy, in order:
      1. ``stems/full.ogg`` (or whichever manifest entry has id=full):
         return its on-disk path. For zip-form sloppaks, extract it
         once into ``tmp_dir`` first.
      2. Multiple per-instrument stems (post-Demucs split): use ffmpeg
         ``amix`` to recombine them into a single ``full.ogg`` in
         ``tmp_dir``. The amix `inputs=N` is set to the actual count
         so we don't over-attenuate.
      3. Otherwise: fail with a clear error.
    """
    stems = _list_stems(manifest)
    if not stems:
        raise RuntimeError("sloppak manifest declares no stems")

    # Step 1: prefer the canonical full-mix entry.
    full_entry: str | None = None
    for entry in manifest.get("stems", []) or []:
        if isinstance(entry, dict) and entry.get("id") == "full":
            f = entry.get("file")
            if isinstance(f, str) and f:
                full_entry = f
                break
    if full_entry is None and len(stems) == 1:
        # No id=full but only one stem — treat it as full-mix anyway.
        full_entry = stems[0]

    if full_entry is not None:
        if sloppak_path.is_dir():
            p = _resolve_within(sloppak_path, full_entry)
            if not p or not p.is_file():
                raise RuntimeError(f"full-mix stem {full_entry!r} missing on disk")
            return p
        # Zip form: extract to tmp.
        out_path = tmp_dir / Path(full_entry).name
        with zipfile.ZipFile(str(sloppak_path), "r") as zf:
            zname = full_entry.replace("\\", "/")
            try:
                with zf.open(zname) as src, open(out_path, "wb") as dst:
                    dst.write(src.read())
            except KeyError:
                raise RuntimeError(f"full-mix stem {full_entry!r} missing from sloppak zip")
        return out_path

    # Step 2: mix all stems together. First materialise each to a known
    # path (extract from zip if needed), then run a single ffmpeg amix.
    stem_paths: list[Path] = []
    for rel in stems:
        if sloppak_path.is_dir():
            p = _resolve_within(sloppak_path, rel)
            if p and p.is_file():
                stem_paths.append(p)
        else:
            zname = rel.replace("\\", "/")
            with zipfile.ZipFile(str(sloppak_path), "r") as zf:
                try:
                    with zf.open(zname) as src:
                        data = src.read()
                except KeyError:
                    continue
            out_path = tmp_dir / f"stem_{len(stem_paths)}_{Path(rel).name}"
            out_path.write_bytes(data)
            stem_paths.append(out_path)
    if not stem_paths:
        raise RuntimeError("no usable stems found inside sloppak")

    mixed = tmp_dir / "full_mixed.ogg"
    cmd: list[str] = [ffmpeg_cmd, "-y"]
    for p in stem_paths:
        cmd += ["-i", str(p)]
    # amix sums inputs with auto-gain compensation; without inputs=N the
    # filter assumes 2 and over-attenuates when we hand it more.
    cmd += [
        "-filter_complex",
        f"amix=inputs={len(stem_paths)}:duration=longest:normalize=0",
        "-c:a", "libvorbis", "-q:a", "3",
        str(mixed),
    ]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0 or not mixed.exists():
        raise RuntimeError(
            f"ffmpeg amix failed (rc={r.returncode}): "
            f"{r.stderr.decode(errors='replace')[:200]}"
        )
    return mixed


def _probe_duration_seconds(audio_path: Path, ffmpeg_cmd: str) -> float:
    """Best-effort duration probe via ffmpeg stderr (no ffprobe dep).

    ``ffmpeg -i <file>`` prints ``Duration: HH:MM:SS.xx`` to stderr even
    when no output is produced (exit code 1 — expected). Parsing the
    line avoids requiring ffprobe to be installed alongside ffmpeg.
    """
    r = subprocess.run(
        [ffmpeg_cmd, "-i", str(audio_path)], capture_output=True
    )
    text = r.stderr.decode(errors="replace")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if not m:
        raise RuntimeError("could not parse duration from ffmpeg output")
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


def build_preview_from_full_audio(
    sloppak_path: Path,
    ffmpeg_cmd: str | None,
    tmp_dir: Path,
) -> tuple[bytes, str]:
    """Produce preview OGG bytes by trimming + fading the sloppak's own audio.

    Returns ``(ogg_bytes, reason_string)`` where ``reason_string``
    describes the offset choice (e.g. "section 'Verse 1'") for logging
    / UI hinting. Raises ``RuntimeError`` on any unrecoverable problem
    (no audio, too short, ffmpeg failure).
    """
    if not ffmpeg_cmd:
        raise RuntimeError("ffmpeg not available")

    manifest, arr_blobs, lyrics_blob = _read_manifest_text(sloppak_path)

    # Manifest is authoritative for duration when present; only probe
    # the audio file as a fallback (probing is a subprocess round-trip).
    try:
        duration = float(manifest.get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0

    full_audio = _materialise_full_audio(sloppak_path, manifest, tmp_dir, ffmpeg_cmd)
    if duration <= 0:
        duration = _probe_duration_seconds(full_audio, ffmpeg_cmd)

    if duration < MIN_SONG_DURATION:
        raise RuntimeError(
            f"song too short for preview "
            f"({duration:.1f}s < {MIN_SONG_DURATION:.1f}s minimum)"
        )

    start, reason = _resolve_preview_start(
        manifest, arr_blobs, lyrics_blob, duration, full_audio, ffmpeg_cmd
    )

    out_ogg = tmp_dir / "preview.ogg"
    # afade `st` is relative to the OUTPUT timeline (after -ss seek).
    # Fade-out starts at duration-fade_out so it lands exactly on the
    # clip's tail.
    fade_out_start = FALLBACK_PREVIEW_DURATION - FALLBACK_FADE_OUT
    afade = (
        f"afade=t=in:st=0:d={FALLBACK_FADE_IN},"
        f"afade=t=out:st={fade_out_start}:d={FALLBACK_FADE_OUT}"
    )
    # -ss BEFORE -i is the fast seek (keyframe-accurate). -ss AFTER -i
    # is slow but precise. For OGG/Vorbis input the difference is
    # negligible — pre-input keeps decode work small.
    cmd = [
        ffmpeg_cmd, "-y",
        "-ss", f"{start:.3f}",
        "-i", str(full_audio),
        "-t", f"{FALLBACK_PREVIEW_DURATION:.3f}",
        "-af", afade,
        "-c:a", "libvorbis", "-q:a", "3",
        str(out_ogg),
    ]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0 or not out_ogg.exists() or out_ogg.stat().st_size < 1000:
        raise RuntimeError(
            f"ffmpeg preview build failed (rc={r.returncode}): "
            f"{r.stderr.decode(errors='replace')[:200]}"
        )
    log.info(
        "built preview for %s: start=%.2fs via %s",
        sloppak_path.name, start, reason,
    )
    return out_ogg.read_bytes(), reason


# ── Bulk job state ───────────────────────────────────────────────────────────

@dataclass
class BulkState:
    """Snapshot of an in-progress (or finished) Fix-All run."""
    running: bool = False
    total: int = 0
    done: int = 0
    # `current` is a single representative in-flight song (kept for back-compat);
    # `in_progress` is the full set being worked on right now. With the bounded
    # thread pool several run at once, so the UI marks every `in_progress` song
    # as fixing rather than just one.
    current: str = ""
    in_progress: list[str] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    # Filenames fixed successfully so far, cumulative. Lets the UI drop each
    # song from the missing list the moment its fix lands, instead of waiting
    # for the whole run to finish. Errored songs are NOT listed here — they
    # stay visible (in `errors`) so the user can retry them.
    done_files: list[str] = field(default_factory=list)
    started_at: float = 0.0
    finished_at: float = 0.0

    def snapshot(self) -> dict:
        return {
            "running": self.running,
            "total": self.total,
            "done": self.done,
            "current": self.current,
            "in_progress": list(self.in_progress),
            "errors": list(self.errors),
            "done_files": list(self.done_files),
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


# Parallelism for a Fix-All run. Each song's fix is dominated by ffmpeg /
# vgmstream subprocesses, which release the GIL while the child runs, so worker
# threads genuinely overlap across cores. Capped modestly (rather than at full
# cpu_count) because ffmpeg is itself multi-threaded — a small pool overlaps the
# process-spawn + I/O + decode without oversubscribing the CPU.
_BULK_MAX_WORKERS = max(1, min(4, os.cpu_count() or 1))


class BulkRunner:
    """Single-flight bulk-backfill executor.

    Only one Fix-All can run at a time; a second start request while one is
    running is rejected. The run itself fixes up to ``_BULK_MAX_WORKERS`` songs
    in parallel via a bounded thread pool. State is snapshot-readable from any
    thread (the GET /backfill-status endpoint reads it); all mutations are under
    ``self._lock``, and each song's fix touches only its own files + temp dir,
    so the parallelism is safe.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = BulkState()

    def state(self) -> dict:
        with self._lock:
            return self._state.snapshot()

    def start(
        self,
        entries: list[MissingEntry],
        do_one: Callable[[MissingEntry], None],
    ) -> bool:
        """Kick off the run in a background thread. Returns False if a
        previous run is still in progress."""
        with self._lock:
            if self._state.running:
                return False
            self._state = BulkState(
                running=True,
                total=len(entries),
                done=0,
                current="",
                errors=[],
                started_at=time.time(),
            )
        t = threading.Thread(
            target=self._run, args=(entries, do_one), daemon=True
        )
        t.start()
        return True

    def _run(
        self,
        entries: list[MissingEntry],
        do_one: Callable[[MissingEntry], None],
    ) -> None:
        def work(entry: MissingEntry) -> None:
            with self._lock:
                self._state.in_progress.append(entry.filename)
                self._state.current = entry.filename
            ok, err = True, None
            try:
                do_one(entry)
            except Exception as e:  # noqa: BLE001 — one bad song mustn't abort the run
                ok, err = False, e
                log.warning("backfill failed for %s: %s", entry.filename, e)
            with self._lock:
                try:
                    self._state.in_progress.remove(entry.filename)
                except ValueError:
                    pass
                # Keep `current` pointing at something still in flight.
                self._state.current = (
                    self._state.in_progress[0] if self._state.in_progress else ""
                )
                if ok:
                    self._state.done_files.append(entry.filename)
                else:
                    self._state.errors.append({
                        "filename": entry.filename,
                        "error": str(err),
                    })
                self._state.done += 1

        # ThreadPoolExecutor's context exit waits for every task, so the run is
        # complete before we flip running=False. Exceptions are swallowed inside
        # `work`, so map() never raises.
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=_BULK_MAX_WORKERS,
            thread_name_prefix="song_preview_backfill",
        ) as pool:
            list(pool.map(work, entries))

        with self._lock:
            self._state.running = False
            self._state.current = ""
            self._state.in_progress = []
            self._state.finished_at = time.time()