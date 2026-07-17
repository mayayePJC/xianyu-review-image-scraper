#!/usr/bin/env python

import csv
import json
import tempfile
from pathlib import Path

import ocr_uid_from_images as ocr
from PIL import Image


def test_calibration_validation(temp_root: Path) -> None:
    calibration = temp_root / "calibration.json"
    original_files = ocr.LOCAL_CALIBRATION_FILES
    try:
        ocr.LOCAL_CALIBRATION_FILES = (calibration,)
        calibration.write_text(json.dumps({"image-one": "234567890123"}), encoding="utf-8")
        assert ocr.load_local_calibration_samples()["image-one"] == "234567890123"

        calibration.write_text(json.dumps({"image-one": "118087811031"}), encoding="utf-8")
        try:
            ocr.load_local_calibration_samples()
            raise AssertionError("invalid UID must be rejected")
        except ValueError:
            pass

        calibration.write_text("{broken", encoding="utf-8")
        try:
            ocr.load_local_calibration_samples()
            raise AssertionError("malformed calibration JSON must be reported")
        except RuntimeError:
            pass
    finally:
        ocr.LOCAL_CALIBRATION_FILES = original_files


def test_atomic_csv_round_trip(temp_root: Path) -> None:
    target = temp_root / "image_state.csv"
    rows = [{"image_id": "one", "notes": "line one\nline two", "uid": "234567890123", "usable": "yes"}]
    ocr.write_csv_rows(target, rows)
    with target.open("r", encoding="utf-8-sig", newline="") as handle:
        saved = list(csv.DictReader(handle))
    assert saved[0]["notes"] == "line one\nline two"
    assert not list(temp_root.glob("*.tmp"))


def test_uid_shape_rules() -> None:
    assert ocr.uid_prefix_is_plausible("234567890123")
    assert not ocr.uid_prefix_is_plausible("118087811031")
    assert not ocr.uid_prefix_is_plausible("222222222222")
    assert ocr.resolve_local_path("") is None


def test_template_library_excludes_current_sample_without_disk_io() -> None:
    glyph = Image.new("L", (12, 16), 255)
    library = {
        "sample-a": {"2": [glyph]},
        "sample-b": {"1": [glyph]},
    }
    templates = ocr.templates_from_library(library, exclude_image_ids=["sample-a"])
    assert "2" not in templates
    assert "1" in templates


def main() -> None:
    script_dir = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix=".tmp-ocr-test-", dir=script_dir) as raw_temp:
        temp_root = Path(raw_temp)
        test_calibration_validation(temp_root)
        test_atomic_csv_round_trip(temp_root)
        test_uid_shape_rules()
        test_template_library_excludes_current_sample_without_disk_io()
    print("ocr logic tests passed")


if __name__ == "__main__":
    main()
