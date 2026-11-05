"""Read-only checkpoint audit; never loads credentials or submits transactions."""
import argparse
import csv
import json
import time
from datetime import datetime, timezone
from pathlib import Path


def summarize(root):
    networks = []
    rows = []
    for network in ("sepolia", "arbitrumSepolia", "megaethTestnet"):
        directory = root / network
        status_file = directory / "status.json"
        status = json.loads(status_file.read_text(encoding="utf-8-sig")) if status_file.exists() else {}
        networks.append({"network": network, "state": status.get("state", "not_started"),
                         "current_job": status.get("current_job"),
                         "updated_at_utc": status.get("updated_at_utc")})
        for checkpoint in sorted(directory.glob("*.checkpoint.json")):
            saved = json.loads(checkpoint.read_text(encoding="utf-8-sig"))
            identity = saved["identity"]
            chunks = (identity["sample_bytes"] + identity["chunk_bytes"] - 1) // identity["chunk_bytes"]
            operations = saved["operations"]
            confirmed = {k: v for k, v in operations.items() if v.get("status") == 1}
            hashes = [v["hash"] for v in operations.values()]
            expected = {"deployDemand", "deployOVCIdentitySegmented", "setCoordinator",
                        "postDemand", "prepareBinding", "sealCiphertext", "commitClaim",
                        "setDemand", "configureWitnessTerms", "disputeClaim", "revealKey",
                        "startAdjudication", "finalizeAdjudication"}
            expected.update(f"depositCiphertextChunk[{i}]" for i in range(chunks))
            expected.update(f"processChunk[{i}]" for i in range(chunks))
            complete = saved.get("outcome") == "Valid"
            audited = (complete and set(confirmed) == expected and len(set(hashes)) == len(hashes)
                       and Path(saved.get("summary_path", "__missing__")).is_file())
            rows.append({"network": network, "job": checkpoint.name.removesuffix(".checkpoint.json"),
                         "sample_bytes": identity["sample_bytes"], "chunks": chunks,
                         "expected_transactions": len(expected), "confirmed_transactions": len(confirmed),
                         "pending_transactions": len(operations) - len(confirmed),
                         "confirmed_gas_including_setup": sum(int(v["gas_used"]) for v in confirmed.values()),
                         "confirmed_fee_wei_including_setup": sum(int(v["fee_wei"]) for v in confirmed.values()),
                         "checkpoint_launches": saved["launches"],
                         "timing_interrupted": saved["launches"] > 1,
                         "outcome": saved.get("outcome", "incomplete"),
                         "audit": "pass" if audited else ("fail" if complete else "pending"),
                         "summary_path": saved.get("summary_path", "")})
    report = {"observed_at_utc": datetime.now(timezone.utc).isoformat(), "networks": networks,
              "jobs": rows, "all_12_jobs_valid_and_audited": len(rows) == 12 and all(r["audit"] == "pass" for r in rows),
              "notes": ["Identity only; three slicer outputs of one geometry, plus two-chunk smoke per network.",
                        "Resumed durations include downtime; do not interpret as uninterrupted latency.",
                        "CSV gas and fee totals include setup; original protocol summaries exclude setup."]}
    target = root / "campaign-audit.json"
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)
    if rows:
        target = root / "campaign-audit.csv"
        temporary = target.with_suffix(".csv.tmp")
        with temporary.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        temporary.replace(target)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("campaign_directory", type=Path)
    parser.add_argument("--watch", action="store_true", help="Refresh every 60 seconds until workers finish or pause")
    args = parser.parse_args()
    while True:
        report = summarize(args.campaign_directory)
        print(json.dumps({"at": report["observed_at_utc"], "networks": report["networks"],
                          "all_valid": report["all_12_jobs_valid_and_audited"]}), flush=True)
        if not args.watch or all(n["state"] in {"complete", "needs_review", "paused_deadline"} for n in report["networks"]):
            break
        time.sleep(60)
