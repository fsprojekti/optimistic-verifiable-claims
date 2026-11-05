"""Copy the smallest corpus inputs, accepting only exact frozen manifest hashes.

Some Windows working copies have LF converted to CRLF. Recover LF only when
that produces the published SHA-256; preserve genuine CRLF artifacts unchanged.
Original corpus files are never edited. This does not regenerate slicer output.
"""

import argparse
import csv
import hashlib
import json
from pathlib import Path
import shutil


def main():
    project = Path(__file__).resolve().parents[4]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--files", type=int, default=3)
    parser.add_argument("--output", type=Path,
                        default=project / "_local-tools/ovc-d5-canonical-corpus")
    args = parser.parse_args()
    source = project / "research/stage-02-secure-real-corpus-validation/data/corpus/generated"
    destination = args.output.resolve()
    if destination == source.resolve() or source.resolve() in destination.parents:
        raise ValueError("Use a separate output directory outside the original corpus")
    manifest = source / "gcode-manifest.csv"
    with manifest.open(encoding="utf-8-sig", newline="") as stream:
        rows = sorted(csv.DictReader(stream), key=lambda row: int(row["size_bytes"]))
    if not 1 <= args.files <= len(rows):
        raise ValueError(f"--files must be between 1 and {len(rows)}")
    audit = []
    for row in rows[:args.files]:
        relative = Path(row["output_file"])
        source_file = (source / relative).resolve()
        target = (destination / relative).resolve()
        if source.resolve() not in source_file.parents or destination not in target.parents:
            raise ValueError("Manifest path escapes corpus directory")
        original = source_file.read_bytes()
        original_hash = hashlib.sha256(original).hexdigest()
        data = original
        action = "byte-for-byte copy"
        if original_hash != row["output_sha256"]:
            data = original.replace(b"\r\n", b"\n")
            action = "CRLF to LF; exact frozen SHA-256 verified"
        if (len(data) != int(row["size_bytes"])
                or hashlib.sha256(data).hexdigest() != row["output_sha256"]):
            raise ValueError(f"Cannot recover frozen artifact: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        audit.append({"artifact": f"{row['model_id']}:{row['slicer']}",
                      "original_sha256": original_hash,
                      "canonical_sha256": row["output_sha256"],
                      "canonical_bytes": len(data), "action": action})
    shutil.copyfile(manifest, destination / "gcode-manifest.csv")
    (destination / "input-recovery.json").write_text(
        json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    print(f"Verified {len(audit)} exact frozen artifacts in {destination}")


if __name__ == "__main__":
    main()
