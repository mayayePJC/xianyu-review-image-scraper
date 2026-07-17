#!/usr/bin/env python
# -*- coding: utf-8 -*-

from __future__ import annotations

import argparse
import csv
import json
import os
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from PIL import Image


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent if SCRIPT_DIR.name.lower() == "_internal" else SCRIPT_DIR
IMAGE_STATE_HEADERS = [
    "image_id",
    "seller_id",
    "link_id",
    "keyword",
    "seller_url",
    "review_url",
    "thumb_url",
    "original_url",
    "local_path",
    "source",
    "width",
    "height",
    "content_type",
    "bytes",
    "sha256",
    "status",
    "downloaded_at",
    "notes",
    "uid",
    "usable",
]

UID_SAMPLE_IMAGE_ID = ""
UID_SAMPLE_VALUE = ""

# Optional local calibration samples. Keep real image IDs and verified UID values
# in your private working copy, not in public commits.
UID_CALIBRATION_SAMPLES = {}
LOCAL_CALIBRATION_FILES = (
    SCRIPT_DIR / "ocr_uid_calibration.local.json",
    ROOT / "config" / "ocr_uid_calibration.local.json",
)

UID_REGION_THRESHOLD = 105
UID_DIGIT_THRESHOLDS = (145, 125, 105)
UID_AUTO_USABLE_PREFIXES = ("2",)

Component = Tuple[int, int, int, int, int]


def read_csv_rows(path: Path) -> List[dict]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_local_calibration_samples() -> Dict[str, str]:
    samples = dict(UID_CALIBRATION_SAMPLES)
    for path in LOCAL_CALIBRATION_FILES:
        if not path.exists():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            raise RuntimeError(f"Cannot read OCR calibration file: {path}: {exc}") from exc
        if isinstance(raw, dict):
            pairs = raw.items()
        elif isinstance(raw, list):
            pairs = ((item.get("image_id"), item.get("uid")) for item in raw if isinstance(item, dict))
        else:
            pairs = ()
        for image_id, uid in pairs:
            image_id = str(image_id or "").strip()
            uid = str(uid or "").strip()
            if image_id and uid:
                if len(uid) != 12 or not uid.isdigit() or not uid.startswith("2"):
                    raise ValueError(f"Invalid calibration UID for {image_id}: expected 12 digits starting with 2")
                samples[image_id] = uid
    return samples


def write_csv_rows(path: Path, rows: List[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with temp_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=IMAGE_STATE_HEADERS, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow({header: row.get(header, "") for header in IMAGE_STATE_HEADERS})
        for attempt in range(7):
            try:
                os.replace(temp_path, path)
                break
            except PermissionError:
                if attempt >= 6:
                    raise
                time.sleep(0.025 * (attempt + 1))
    finally:
        temp_path.unlink(missing_ok=True)


def resolve_local_path(raw: str) -> Optional[Path]:
    text = str(raw or "").strip()
    if not text:
        return None
    path = Path(text)
    if path.is_absolute():
        return path
    return ROOT / path


def binarize_uid_roi(img: Image.Image, threshold: int = 105) -> Image.Image:
    gray = img.convert("L")
    w, h = gray.size
    # UID is rendered in the lower-left corner in the game screenshots. Keep a
    # slightly wider lower-left band because comments may contain screenshots
    # with different aspect ratios.
    roi = gray.crop((0, int(h * 0.82), int(w * 0.34), int(h * 0.995)))
    return roi.point(lambda p: 255 if p >= threshold else 0, "L")


def component_width(comp: Component) -> int:
    return comp[2] - comp[0]


def component_height(comp: Component) -> int:
    return comp[3] - comp[1]


def y_overlap(a: Component, b: Component) -> int:
    return max(0, min(a[3], b[3]) - max(a[1], b[1]))


def connected_components(img: Image.Image) -> List[Component]:
    pix = img.load()
    w, h = img.size
    seen = bytearray(w * h)
    comps: List[Component] = []

    for y in range(h):
        for x in range(w):
            idx = y * w + x
            if seen[idx] or not pix[x, y]:
                continue
            stack = [(x, y)]
            seen[idx] = 1
            xs: List[int] = []
            ys: List[int] = []
            area = 0
            while stack:
                cx, cy = stack.pop()
                xs.append(cx)
                ys.append(cy)
                area += 1
                for ny in range(max(0, cy - 1), min(h, cy + 2)):
                    for nx in range(max(0, cx - 1), min(w, cx + 2)):
                        nidx = ny * w + nx
                        if seen[nidx] or not pix[nx, ny]:
                            continue
                        seen[nidx] = 1
                        stack.append((nx, ny))
            comps.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1, area))
    return comps


def is_main_char(comp: Component) -> bool:
    width = component_width(comp)
    height = component_height(comp)
    area = comp[4]
    return 6 <= width <= 24 and 8 <= height <= 28 and 20 <= area <= 220


def is_thin_char(comp: Component) -> bool:
    width = component_width(comp)
    height = component_height(comp)
    area = comp[4]
    return 1 <= width <= 5 and 8 <= height <= 28 and 8 <= area <= 80


def is_colon_dot(comp: Component) -> bool:
    width = component_width(comp)
    height = component_height(comp)
    area = comp[4]
    return 1 <= width <= 5 and 1 <= height <= 5 and 2 <= area <= 18


def is_digit_piece(comp: Component) -> bool:
    width = component_width(comp)
    height = component_height(comp)
    area = comp[4]
    return 1 <= width <= 64 and 5 <= height <= 30 and 3 <= area <= 420


def same_text_band(a: Component, b: Component, min_ratio: float = 0.55) -> bool:
    overlap = y_overlap(a, b)
    return overlap >= min(component_height(a), component_height(b)) * min_ratio


def find_colon_pair(digit_like: List[Component], d_comp: Component) -> Optional[Tuple[Component, Component]]:
    dots = [
        comp for comp in digit_like
        if is_colon_dot(comp)
        and 1 <= comp[0] - d_comp[2] <= 12
        and same_text_band((d_comp[0], d_comp[1], d_comp[2], d_comp[3], d_comp[4]), (d_comp[0], comp[1], d_comp[2], comp[3], comp[4]), 0.05)
    ]
    best: Optional[Tuple[Component, Component]] = None
    best_score = 10_000
    for upper in dots:
        for lower in dots:
            if lower is upper:
                continue
            if lower[1] <= upper[1]:
                continue
            x_close = abs(((upper[0] + upper[2]) / 2) - ((lower[0] + lower[2]) / 2))
            if x_close > 3:
                continue
            gap = lower[1] - upper[3]
            if gap < 3 or gap > 12:
                continue
            score = int(x_close * 10) + abs(gap - 5)
            if score < best_score:
                best_score = score
                best = (upper, lower)
    return best


def find_uid_region(binary: Image.Image) -> Optional[Tuple[int, int, int, int, int]]:
    comps = connected_components(binary)
    if not comps:
        return None
    width, height = binary.size
    usable = [comp for comp in comps if comp[4] >= 2 and component_width(comp) <= 80 and component_height(comp) <= 35]
    main_chars = [comp for comp in usable if is_main_char(comp)]
    thin_chars = [comp for comp in usable if is_thin_char(comp)]
    digit_like = [comp for comp in usable if is_digit_piece(comp)]
    colon_like = [comp for comp in usable if is_colon_dot(comp)]
    candidates: List[Tuple[float, Tuple[int, int, int, int, int]]] = []

    for u_comp in main_chars:
        if u_comp[1] < height * 0.45:
            continue
        for i_comp in thin_chars:
            if not same_text_band(u_comp, i_comp):
                continue
            if not 0 <= i_comp[0] - u_comp[2] <= 5:
                continue
            for d_comp in main_chars:
                if not same_text_band(u_comp, d_comp):
                    continue
                if not 1 <= d_comp[0] - i_comp[2] <= 8:
                    continue
                colon = find_colon_pair(colon_like, d_comp)
                if not colon:
                    continue
                colon_right = max(colon[0][2], colon[1][2])
                digit_x0 = colon_right + 4
                band_y0 = min(u_comp[1], i_comp[1], d_comp[1], colon[0][1], colon[1][1])
                band_y1 = max(u_comp[3], i_comp[3], d_comp[3], colon[0][3], colon[1][3])
                band = (u_comp[0], band_y0, d_comp[2], band_y1, 1)
                right_edge = digit_x0
                digit_count = 0
                last_right = digit_x0
                for comp in sorted(digit_like, key=lambda item: (item[0], item[1])):
                    if comp[0] < digit_x0 - 2:
                        continue
                    if y_overlap(comp, band) < min(component_height(comp), component_height(band)) * 0.35:
                        continue
                    if digit_count and comp[0] - last_right > 28:
                        break
                    right_edge = max(right_edge, comp[2])
                    last_right = max(last_right, comp[2])
                    digit_count += 1
                text_width = right_edge - u_comp[0]
                digit_width = right_edge - digit_x0
                if digit_count < 5 or not (70 <= digit_width <= 180) or not (95 <= text_width <= 230):
                    continue
                gap_score = abs((i_comp[0] - u_comp[2]) - 1) + abs((d_comp[0] - i_comp[2]) - 2)
                height_score = abs(component_height(u_comp) - component_height(d_comp))
                bottom_bonus = (height - band_y1) / max(height, 1)
                score = gap_score + height_score + bottom_bonus * 4 - min(digit_count, 12) * 0.2
                candidates.append((score, (u_comp[0], max(0, band_y0 - 2), min(width, right_edge + 1), min(height, band_y1 + 2), digit_x0)))

        # Some screenshots have the I and D in "UID:" touching, so they are a
        # single component. Accept that shape only when the colon pair and a
        # compact 12-digit strip are present on the same lower-left text band.
        for id_comp in main_chars:
            if not same_text_band(u_comp, id_comp):
                continue
            if not 0 <= id_comp[0] - u_comp[2] <= 6:
                continue
            if not 8 <= component_width(id_comp) <= 18:
                continue
            colon = find_colon_pair(colon_like, id_comp)
            if not colon:
                continue
            colon_right = max(colon[0][2], colon[1][2])
            digit_x0 = colon_right + 4
            band_y0 = min(u_comp[1], id_comp[1], colon[0][1], colon[1][1])
            band_y1 = max(u_comp[3], id_comp[3], colon[0][3], colon[1][3])
            band = (u_comp[0], band_y0, id_comp[2], band_y1, 1)
            right_edge = digit_x0
            digit_count = 0
            last_right = digit_x0
            for comp in sorted(digit_like, key=lambda item: (item[0], item[1])):
                if comp[0] < digit_x0 - 2:
                    continue
                if y_overlap(comp, band) < min(component_height(comp), component_height(band)) * 0.35:
                    continue
                if digit_count and comp[0] - last_right > 28:
                    break
                right_edge = max(right_edge, comp[2])
                last_right = max(last_right, comp[2])
                digit_count += 1
            text_width = right_edge - u_comp[0]
            digit_width = right_edge - digit_x0
            if digit_count < 5 or not (70 <= digit_width <= 180) or not (95 <= text_width <= 230):
                continue
            gap_score = abs((id_comp[0] - u_comp[2]) - 1) + 2
            height_score = abs(component_height(u_comp) - component_height(id_comp))
            bottom_bonus = (height - band_y1) / max(height, 1)
            score = gap_score + height_score + bottom_bonus * 4 - min(digit_count, 12) * 0.2 + 1.5
            candidates.append((score, (u_comp[0], max(0, band_y0 - 2), min(width, right_edge + 1), min(height, band_y1 + 2), digit_x0)))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return candidates[0][1]


def bright_bbox(img: Image.Image) -> Optional[Tuple[int, int, int, int]]:
    pix = img.load()
    w, h = img.size
    xs: List[int] = []
    ys: List[int] = []
    for y in range(h):
        for x in range(w):
            if pix[x, y]:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def text_bitmap(img: Image.Image) -> Optional[Image.Image]:
    bbox = bright_bbox(img)
    if not bbox:
        return None
    x0, y0, x1, y1 = bbox
    # Drop stray pixels above/below by using the compact bright-pixel bbox.
    return img.crop((x0, y0, x1, y1))


def bitmap_to_matrix(img: Image.Image) -> List[List[int]]:
    pix = img.load()
    w, h = img.size
    return [[1 if pix[x, y] else 0 for x in range(w)] for y in range(h)]


def resize_nearest(img: Image.Image, size: Tuple[int, int]) -> Image.Image:
    return img.resize(size, Image.Resampling.NEAREST)


def glyph_score(a: Image.Image, b: Image.Image) -> float:
    if a.size != b.size:
        b = resize_nearest(b, a.size)
    aw, ah = a.size
    ap = a.load()
    bp = b.load()
    diff = 0
    total = aw * ah
    for y in range(ah):
        for x in range(aw):
            if bool(ap[x, y]) != bool(bp[x, y]):
                diff += 1
    return diff / max(total, 1)


def normalized_glyph(img: Image.Image) -> Image.Image:
    return resize_nearest(img, (18, 22))


def bright_column_runs(img: Image.Image, min_column_pixels: int = 1) -> List[Tuple[int, int]]:
    pix = img.load()
    w, h = img.size
    columns = [sum(1 for y in range(h) if pix[x, y]) for x in range(w)]
    runs: List[Tuple[int, int]] = []
    start: Optional[int] = None
    for x, count in enumerate(columns):
        if count >= min_column_pixels and start is None:
            start = x
        elif count < min_column_pixels and start is not None:
            runs.append((start, x))
            start = None
    if start is not None:
        runs.append((start, w))
    return runs


def merge_tiny_gaps(runs: List[Tuple[int, int]], max_gap: int = 1) -> List[Tuple[int, int]]:
    if not runs:
        return []
    merged = [runs[0]]
    for start, end in runs[1:]:
        prev_start, prev_end = merged[-1]
        if start - prev_end <= max_gap:
            merged[-1] = (prev_start, end)
        else:
            merged.append((start, end))
    return merged


def split_wide_run(img: Image.Image, run: Tuple[int, int], target_parts: int) -> List[Tuple[int, int]]:
    start, end = run
    width = end - start
    if target_parts <= 1 or width <= target_parts:
        return [run]
    pix = img.load()
    _w, h = img.size
    columns = [sum(1 for y in range(h) if pix[x, y]) for x in range(start, end)]
    cuts = []
    for part in range(1, target_parts):
      ideal = round(width * part / target_parts)
      left = max(1, ideal - 3)
      right = min(width - 1, ideal + 4)
      best = min(range(left, right), key=lambda idx: (columns[idx], abs(idx - ideal)))
      cuts.append(start + best)
    points = [start, *sorted(set(cuts)), end]
    return [(points[i], points[i + 1]) for i in range(len(points) - 1) if points[i + 1] > points[i]]


def digit_glyphs_from_components(digit_area: Image.Image) -> Optional[List[Image.Image]]:
    bbox = bright_bbox(digit_area)
    if not bbox:
        return None
    x0, y0, x1, y1 = bbox
    compact = digit_area.crop((x0, y0, x1, y1))
    runs = merge_tiny_gaps(bright_column_runs(compact), max_gap=0)
    if len(runs) > 12:
        return None
    if len(runs) < 12:
        widths = [end - start for start, end in runs]
        typical = sorted(widths)[max(0, len(widths) // 2 - 1)] if widths else 8
        expanded: List[Tuple[int, int]] = []
        missing = 12 - len(runs)
        for run in runs:
            width = run[1] - run[0]
            parts = 1
            if missing > 0 and typical > 0 and width >= typical * 1.65:
                parts = min(missing + 1, max(2, round(width / typical)))
            split = split_wide_run(compact, run, parts)
            missing -= len(split) - 1
            expanded.extend(split)
        runs = expanded
    if len(runs) != 12:
        return None
    glyphs: List[Image.Image] = []
    for start, end in runs:
        pad = 1
        glyph = compact.crop((max(0, start - pad), 0, min(compact.size[0], end + pad), compact.size[1]))
        glyphs.append(normalized_glyph(glyph))
    return glyphs


def digit_area_from_region(binary: Image.Image, region: Tuple[int, int, int, int, int]) -> Optional[Image.Image]:
    _x0, y0, x1, y1, digit_x0 = region
    if x1 - digit_x0 < 60 or y1 - y0 < 8:
        return None
    return binary.crop((digit_x0, y0, x1, y1))


def digit_slots(digit_area: Image.Image) -> List[Image.Image]:
    width, height = digit_area.size
    slot_w = width / 12
    slots: List[Image.Image] = []
    for idx in range(12):
        x0 = max(0, round(idx * slot_w) - 1)
        x1 = min(width, round((idx + 1) * slot_w) + 1)
        slots.append(normalized_glyph(digit_area.crop((x0, 0, x1, height))))
    return slots


def digit_glyphs(digit_area: Image.Image) -> List[Image.Image]:
    return digit_glyphs_from_components(digit_area) or digit_slots(digit_area)


def add_templates_from_sample(templates: Dict[str, List[Image.Image]], sample_image: Path, uid: str) -> bool:
    try:
        img = Image.open(sample_image)
    except Exception:
        return False
    binary = binarize_uid_roi(img, UID_REGION_THRESHOLD)
    region = find_uid_region(binary)
    if region is None:
        return False
    added = False
    for threshold in UID_DIGIT_THRESHOLDS:
        digit_binary = binarize_uid_roi(img, threshold)
        digit_area = digit_area_from_region(digit_binary, region)
        if digit_area is None:
            continue
        glyphs = digit_glyphs(digit_area)
        if len(glyphs) != len(uid):
            continue
        for digit, glyph in zip(uid, glyphs):
            templates.setdefault(digit, []).append(glyph)
        added = True
    return added


def build_template_library(
    rows: List[dict],
    calibration_samples: Dict[str, str],
) -> Dict[str, Dict[str, List[Image.Image]]]:
    rows_by_id = {row.get("image_id"): row for row in rows}
    library: Dict[str, Dict[str, List[Image.Image]]] = {}
    for image_id, uid in calibration_samples.items():
        row = rows_by_id.get(image_id)
        if not row:
            continue
        path = resolve_local_path(row.get("local_path", ""))
        sample_templates: Dict[str, List[Image.Image]] = {}
        if path and path.exists() and add_templates_from_sample(sample_templates, path, uid):
            library[image_id] = sample_templates
    if not library:
        sample = find_sample_path(rows)
        sample_templates = {}
        if sample and add_templates_from_sample(sample_templates, sample, UID_SAMPLE_VALUE):
            library[UID_SAMPLE_IMAGE_ID] = sample_templates
    if not library:
        raise RuntimeError("Cannot build UID templates: no usable calibration image found.")
    return library


def templates_from_library(
    library: Dict[str, Dict[str, List[Image.Image]]],
    exclude_image_ids: Optional[Iterable[str]] = None,
) -> Dict[str, List[Image.Image]]:
    excluded = {str(image_id or "").strip() for image_id in (exclude_image_ids or [])}
    templates: Dict[str, List[Image.Image]] = {}
    for image_id, sample_templates in library.items():
        if image_id in excluded:
            continue
        for digit, glyphs in sample_templates.items():
            templates.setdefault(digit, []).extend(glyphs)
    if not templates:
        raise RuntimeError("Cannot build UID templates after excluding calibration samples.")
    missing_digits = [str(digit) for digit in range(10) if str(digit) not in templates]
    if missing_digits:
        fallback = fallback_templates()
        for digit in missing_digits:
            glyphs = fallback.get(digit, [])
            if glyphs:
                templates.setdefault(digit, []).extend(glyphs)
    return templates


def build_templates(
    rows: List[dict],
    exclude_image_ids: Optional[Iterable[str]] = None,
    calibration_samples: Optional[Dict[str, str]] = None,
) -> Dict[str, List[Image.Image]]:
    samples = load_local_calibration_samples() if calibration_samples is None else calibration_samples
    return templates_from_library(build_template_library(rows, samples), exclude_image_ids)


def fallback_templates() -> Dict[str, List[Image.Image]]:
    # 3 and 4 are absent from the calibration UID. These rough seven-segment
    # shapes only help avoid hard failure; low-confidence reads are rejected.
    patterns = {
        "3": ["1110", "0001", "0001", "0110", "0001", "0001", "1110"],
        "4": ["1001", "1001", "1001", "1111", "0001", "0001", "0001"],
    }
    out: Dict[str, List[Image.Image]] = {}
    for digit, rows in patterns.items():
        img = Image.new("L", (12, 16), 0)
        pix = img.load()
        for y, line in enumerate(rows):
            for x, value in enumerate(line):
                if value == "1":
                    for yy in range(y * 2, min(16, y * 2 + 3)):
                        for xx in range(x * 3, min(12, x * 3 + 3)):
                            pix[xx, yy] = 255
        out[digit] = [normalized_glyph(img)]
    return out


def locate_digit_area(text: Image.Image) -> Optional[Image.Image]:
    w, h = text.size
    if w < 80 or h < 8:
        return None
    # The left "UID:" marker is four chars. Keep the trailing numeric strip.
    x0 = round(w * 0.255)
    if w - x0 < 70:
        return None
    return text.crop((x0, 0, w, h))


def uid_prefix_is_plausible(uid: str) -> bool:
    text = str(uid or "")
    if not text.startswith(UID_AUTO_USABLE_PREFIXES):
        return False
    if len(set(text)) <= 2:
        return False
    run = 1
    for idx in range(1, len(text)):
        if text[idx] == text[idx - 1]:
            run += 1
            if run >= 5:
                return False
        else:
            run = 1
    return True


def choose_uid_candidate(candidates: List[Tuple[float, float, float, str, str]]) -> Tuple[float, float, float, str, str, int]:
    plausible = [item for item in candidates if uid_prefix_is_plausible(item[3])]
    pool = plausible or candidates
    position_majority: Dict[int, str] = {}
    if pool:
        width = max(len(item[3]) for item in pool)
        for idx in range(width):
            counts: Dict[str, int] = {}
            for _avg, _worst, _margin, uid, _detail in pool:
                if idx >= len(uid):
                    continue
                counts[uid[idx]] = counts.get(uid[idx], 0) + 1
            if not counts:
                continue
            digit, count = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[0]
            if count >= 2:
                position_majority[idx] = digit
    grouped: Dict[str, List[Tuple[float, float, float, str, str]]] = {}
    for item in pool:
        grouped.setdefault(item[3], []).append(item)
    ranked_groups = []
    for uid, items in grouped.items():
        best = sorted(items, key=lambda item: (item[0], item[1], -item[2]))[0]
        avg = sum(item[0] for item in items) / len(items)
        worst = min(item[1] for item in items)
        margin = max(item[2] for item in items)
        support = sum(1 for idx, digit in position_majority.items() if idx < len(uid) and uid[idx] == digit)
        # A low average alone can over-pick ambiguous glyphs, especially 1/5.
        # Use support first, then prefer candidates whose worst digit is still
        # clean and whose best-vs-second margin is not razor thin.
        quality = avg + worst * 0.08 - margin * 0.35
        ranked_groups.append((-support, -len(items), quality, avg, worst, -margin, best, len(items), uid, support))
    ranked_groups.sort(key=lambda item: item[:5])
    _neg_support, _neg_count, _quality, _avg, _worst, _neg_margin, best, votes, _uid, support = ranked_groups[0]
    avg, worst, margin, uid, detail = best
    if votes > 1 or support:
        detail = f"{detail}:votes={votes}:support={support}"
    return avg, worst, margin, uid, detail, votes


def recognize_uid_from_digit_area(
    digit_area: Image.Image,
    templates: Dict[str, List[Image.Image]],
    threshold: int,
) -> Tuple[str, str, float, float, float]:
    chars: List[str] = []
    scores: List[float] = []
    margins: List[float] = []
    all_templates = templates
    component_glyphs = digit_glyphs_from_components(digit_area)
    glyphs = component_glyphs or digit_slots(digit_area)
    split_mode = "components" if component_glyphs else "slots"
    for glyph in glyphs:
        ranked: List[Tuple[float, str]] = []
        for digit, tmpl_list in all_templates.items():
            ranked.append((min(glyph_score(glyph, tmpl) for tmpl in tmpl_list), digit))
        ranked.sort(key=lambda item: (item[0], item[1]))
        best_score, best_digit = ranked[0] if ranked else (1.0, "")
        second_score = ranked[1][0] if len(ranked) > 1 else 1.0
        chars.append(best_digit)
        scores.append(best_score)
        margins.append(second_score - best_score)
    uid = "".join(chars)
    avg = sum(scores) / len(scores)
    worst = max(scores) if scores else 1.0
    min_margin = min(margins) if margins else 0.0
    return uid, f"threshold={threshold}:split={split_mode}:avg={avg:.3f}:max={worst:.3f}:margin={min_margin:.3f}", avg, worst, min_margin


def uid_candidate_summary(candidates: List[Tuple[float, float, float, str, str]]) -> str:
    parts = []
    for avg, worst, margin, uid, detail in candidates[:5]:
        threshold = "?"
        split_mode = "?"
        for item in detail.split(":"):
            if item.startswith("threshold="):
                threshold = item.split("=", 1)[1]
            elif item.startswith("split="):
                split_mode = item.split("=", 1)[1]
        parts.append(f"{uid}@{threshold}/{split_mode}/a{avg:.3f}/w{worst:.3f}/m{margin:.3f}")
    return "|".join(parts)


def recognize_uid(image_path: Path, templates: Dict[str, List[Image.Image]]) -> Tuple[str, str]:
    try:
        img = Image.open(image_path)
    except Exception as exc:
        return "", f"open_failed:{exc}"
    region_binary = binarize_uid_roi(img, UID_REGION_THRESHOLD)
    region = find_uid_region(region_binary)
    if region is None:
        return "", "uid_marker_not_found"
    candidates: List[Tuple[float, float, float, str, str]] = []
    for threshold in UID_DIGIT_THRESHOLDS:
        digit_binary = binarize_uid_roi(img, threshold)
        digit_area = digit_area_from_region(digit_binary, region)
        if digit_area is None:
            continue
        uid, detail, avg, worst, margin = recognize_uid_from_digit_area(digit_area, templates, threshold)
        if uid.isdigit() and len(uid) == 12:
            candidates.append((avg, worst, margin, uid, detail))
    if not candidates:
        return "", "uid_digit_area_not_found"
    avg, worst, margin, uid, detail, votes = choose_uid_candidate(candidates)
    candidate_summary = uid_candidate_summary(candidates)
    if not uid.isdigit() or len(uid) != 12:
        return "", f"bad_candidate:{uid}:{detail}:candidates={candidate_summary}"
    if not uid_prefix_is_plausible(uid):
        return uid, f"low_confidence:implausible_prefix:{uid}:{detail}:candidates={candidate_summary}"
    if votes < 2 and (avg > 0.13 or worst > 0.24 or margin < 0.015):
        return uid, f"low_confidence:{uid}:{detail}:candidates={candidate_summary}"
    return uid, f"template_avg={avg:.3f}:max={worst:.3f}:{detail}:candidates={candidate_summary}"


def uid_mismatch_detail(recognized_uid: str, verified_uid: str) -> str:
    recognized = str(recognized_uid or "")
    verified = str(verified_uid or "")
    if not recognized or not verified or recognized == verified:
        return ""
    diffs = []
    for idx, (got, expected) in enumerate(zip(recognized, verified), start=1):
        if got != expected:
            diffs.append(f"{idx}:{got}>{expected}")
    if len(recognized) != len(verified):
        diffs.append(f"len:{len(recognized)}>{len(verified)}")
    return "mismatch:" + ",".join(diffs[:8])


def find_sample_path(rows: List[dict]) -> Optional[Path]:
    if not UID_SAMPLE_IMAGE_ID:
        return None
    for row in rows:
        if row.get("image_id") == UID_SAMPLE_IMAGE_ID:
            path = resolve_local_path(row.get("local_path", ""))
            if path and path.exists():
                return path
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract lower-left UID:123... from local review images.")
    parser.add_argument("--image-state", default=str(ROOT / "data" / "image_state.csv"))
    parser.add_argument("--only-image-id", default="")
    parser.add_argument("--link-ids", default="", help="Comma/space separated link_id list to OCR.")
    parser.add_argument("--only-existing-uid", action="store_true", help="Only recheck rows that already have a UID value.")
    parser.add_argument("--force", action="store_true", help="Overwrite existing uid/usable values even when OCR fails.")
    parser.add_argument("--resume", action="store_true", default=True, help="Skip images that already have uid_ocr notes unless --force is used.")
    parser.add_argument("--no-resume", dest="resume", action="store_false", help="Recheck images even when uid_ocr notes already exist.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    image_state = Path(args.image_state)
    rows = read_csv_rows(image_state)
    selected_link_ids = {item.strip() for item in str(args.link_ids or "").replace(",", " ").split() if item.strip()}

    pending_total = 0
    for row in rows:
        if args.only_image_id and row.get("image_id") != args.only_image_id:
            continue
        if selected_link_ids and row.get("link_id") not in selected_link_ids:
            continue
        if args.only_existing_uid and not str(row.get("uid") or "").strip():
            continue
        if args.resume and not args.force and "uid_ocr:" in str(row.get("notes") or ""):
            continue
        pending_total += 1
    print(f"TASK_PROGRESS ocr-uids done=0 total={pending_total}", flush=True)
    calibration_samples: Dict[str, str] = {}
    template_library: Dict[str, Dict[str, List[Image.Image]]] = {}
    shared_templates: Dict[str, List[Image.Image]] = {}
    if pending_total:
        calibration_samples = load_local_calibration_samples()
        template_library = build_template_library(rows, calibration_samples)
        shared_templates = templates_from_library(template_library)

    total = 0
    skipped_done = 0
    usable = 0
    unusable = 0
    for row in rows:
        if args.only_image_id and row.get("image_id") != args.only_image_id:
            continue
        if selected_link_ids and row.get("link_id") not in selected_link_ids:
            continue
        old_notes = str(row.get("notes") or "").strip()
        existing_uid = str(row.get("uid") or "").strip()
        existing_usable = str(row.get("usable") or "").strip().lower()
        if args.only_existing_uid and not existing_uid:
            continue
        if args.resume and not args.force and "uid_ocr:" in old_notes:
            skipped_done += 1
            if existing_uid and existing_usable == "yes":
                usable += 1
            else:
                unusable += 1
            continue
        total += 1
        local_path = resolve_local_path(row.get("local_path", ""))
        uid = ""
        note = ""
        image_id = row.get("image_id", "")
        verified_uid = calibration_samples.get(str(image_id or "").strip(), "")
        templates = shared_templates
        if verified_uid:
            try:
                templates = templates_from_library(template_library, exclude_image_ids=[image_id])
            except RuntimeError:
                templates = {}
        if local_path and local_path.exists() and templates:
            uid, note = recognize_uid(local_path, templates)
            if verified_uid:
                mismatch = uid_mismatch_detail(uid, verified_uid)
                if mismatch:
                    note = f"manual_verified_calibration:machine_uid={uid or '-'}:{note}:verified={verified_uid}:{mismatch}"
                else:
                    note = f"manual_verified_calibration:{note}:verified_match"
        elif local_path and local_path.exists() and verified_uid:
            note = "manual_verified_calibration:machine_uid=-:no_independent_templates:ocr_skipped"
        else:
            note = "local_path_missing"
            if verified_uid:
                note = f"manual_verified_calibration:machine_uid=-:{note}:verified={verified_uid}:ocr_failed"
        if verified_uid:
            uid = verified_uid
            high_confidence = True
        else:
            high_confidence = bool(uid) and not note.startswith("low_confidence:")
        existing_high_confidence = bool(existing_uid) and existing_usable == "yes"
        preserved_existing = False

        if args.force or high_confidence:
            row["uid"] = uid
            row["usable"] = "yes" if high_confidence else "no"
        elif uid and not existing_high_confidence:
            row["uid"] = uid
            row["usable"] = "no"
        elif existing_uid:
            row["uid"] = existing_uid
            row["usable"] = existing_usable if existing_usable in {"yes", "no"} else "yes"
            preserved_existing = True
        else:
            row["uid"] = ""
            row["usable"] = "no"

        if row["usable"] == "yes":
            usable += 1
        else:
            unusable += 1
        ocr_note = f"uid_ocr:{'preserved_existing_uid:' if preserved_existing else ''}{note}"
        kept_notes = [part.strip() for part in old_notes.split(";") if part.strip() and not part.strip().startswith("uid_ocr:")]
        row["notes"] = "; ".join([*kept_notes, ocr_note])
        preserved = " preserved_existing" if preserved_existing else ""
        print(f"{row.get('image_id','')} uid={row['uid'] or '-'} usable={row['usable']} {note}{preserved}")
        print(f"TASK_PROGRESS ocr-uids done={total} total={pending_total}", flush=True)
        if not args.dry_run and total % 25 == 0:
            write_csv_rows(image_state, rows)

    if not args.dry_run:
        write_csv_rows(image_state, rows)
    print(f"Processed: {total}, skipped_done: {skipped_done}, usable: {usable}, unusable: {unusable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
