"""Verify imported evidence and declared Stage 04 code revisions offline."""

import hashlib
import json
import os
from pathlib import Path


def main():
    stage = Path(__file__).resolve().parents[2]
    if os.name == "nt" and not str(stage).startswith("\\\\?\\"):
        stage = Path("\\\\?\\" + str(stage))
    manifest = json.loads((stage / "provenance/import-manifest.json").read_text(encoding="utf-8"))
    changes_path = stage / "provenance/stage04-changes.json"
    changes = {entry["path"]: entry for entry in json.loads(changes_path.read_text(encoding="utf-8"))["files"]} if changes_path.exists() else {}
    verified = 0
    missing_inputs = []
    failures = []
    for entry in manifest["files"]:
        relative = Path(entry["destination"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"Invalid import destination: {relative}")
        path = stage / relative
        if not path.is_file():
            if relative.suffix == ".gcode":
                missing_inputs.append(relative.as_posix())
                continue
            failures.append(f"Missing: {relative}")
            continue
        data = path.read_bytes()
        change = changes.get(relative.as_posix())
        if change and change["import_sha256"] != entry["sha256"]:
            failures.append(f"Wrong import baseline: {relative}")
            continue
        expected_hash = change["current_sha256"] if change else entry["sha256"]
        expected_bytes = change["current_bytes"] if change else entry["bytes"]
        if len(data) != expected_bytes or hashlib.sha256(data).hexdigest() != expected_hash:
            failures.append(f"Changed: {relative}")
        else:
            verified += 1
    for failure in failures:
        print(failure)
    for missing in missing_inputs:
        print(f"Restore frozen corpus input for execution: {missing}")
    print(f"Verified {verified} entries including {len(changes)} declared code revisions; {len(missing_inputs)} local inputs absent; {len(failures)} failures.")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
