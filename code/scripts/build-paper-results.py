"""Generate Stage 04 paper tables and figures from frozen local measurements.

No RPC access, transaction submission, or edits to the imported evidence.
"""

import csv
import hashlib
import json
import runpy
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

STAGE = Path(__file__).resolve().parents[2]
RAW = STAGE / "results/raw-data"
PAPER = STAGE / "paper/latex"
RECOVERY = RAW / "duration-campaigns/d5-recovery-2026-10-12"


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def table(name, caption, label, columns, header, rows, note="", placement="htbp"):
    text = [r"\begin{table}[" + placement + "]", r"\centering\small", r"\caption{" + caption + "}",
            r"\label{" + label + "}", r"\begin{tabular}{@{}" + columns + "@{}}",
            r"\toprule", " & ".join(header) + r" \\", r"\midrule"]
    text += [" & ".join(map(str, row)) + r" \\" for row in rows]
    text += [r"\bottomrule", r"\end{tabular}"]
    if note:
        text += [r"\par\smallskip\parbox{\textwidth}{\footnotesize " + note + "}"]
    text += [r"\end{table}"]
    (PAPER / "tables" / name).write_text("\n".join(text) + "\n", encoding="utf-8")


def main():
    for directory in [PAPER / "tables", PAPER / "img", STAGE / "results/derived/paper"]:
        directory.mkdir(parents=True, exist_ok=True)
    paths = [RAW / "stage03-d5-canonical-3072/real-corpus-anvil-summary.csv",
             RAW / "stage03-d5-canonical-3072/real-corpus-anvil-predicates.csv",
             RAW / "stage03-d5-chunk-spectrum/chunk-spectrum-summary.csv",
             RECOVERY / "analysis/full-artifact-comparison.csv",
             RECOVERY / "analysis/final-measurements.json",
             STAGE / "data/corpus/generated/gcode-manifest.csv",
             STAGE / "results/validation/access-real-corpus.json",
             STAGE / "results/validation/suite-summary.json",
             STAGE / "results/access-testnets/2026-10-14/rpc-audit.json",
             RAW / "stage03-d5-canonical-3072/real-corpus-anvil-transactions.csv"]
    local, predicates, spectrum, public = [read_csv(p) for p in paths[:4]]
    final = json.loads(paths[4].read_text(encoding="utf-8"))
    corpus = read_csv(paths[5])
    access = json.loads(paths[6].read_text(encoding="utf-8"))
    suite = json.loads(paths[7].read_text(encoding="utf-8"))
    public_access = json.loads(paths[8].read_text(encoding="utf-8"))
    local_transactions = read_csv(paths[9])
    assert len(local_transactions) == 1744
    assert all(int(r["status"]) == 1 for r in local_transactions)
    assert public_access["completed_jobs"] == 9 and public_access["verified_unique_successful_receipts"] == 117
    assert all(len(n["jobs"]) == 3 and not n.get("error") for n in public_access["networks"])
    assert suite["passing"] == 49 and suite["pending"] == 1
    assert len(access["artifacts"]) == 3 and len(access["transactions"]) == 302
    assert all(r["access_outcome"] == "Valid" and r["private_handover_verified"] for r in access["artifacts"])
    assert len(corpus) == 60 and len({r["model_id"] for r in corpus}) == 20
    assert final["completed_jobs"] == 12 and final["unique_successful_transactions"] == 1866
    assert len(public) == len(predicates) == 9 and len(spectrum) == 4
    assert all(r["outcome"] == "Valid" for rows in [local, predicates, spectrum, public] for r in rows)
    assert len(final["full_artifact_comparisons"]) == 9
    for row, recorded in zip(public, final["full_artifact_comparisons"]):
        assert row["network"] == recorded["network"] and row["slicer"] == recorded["slicer"]
        for key in ["bytes", "chunks", "protocol_gas", "ciphertext_upload_gas", "identity_processing_gas"]:
            assert int(row[key]) == recorded[key]
    slicers = ["cura", "orca", "prusa"]
    names = {"cura": "Cura", "orca": "Orca", "prusa": "Prusa"}
    networks = ["sepolia", "arbitrumSepolia", "megaethTestnet"]
    network_names = {"sepolia": "Sepolia", "arbitrumSepolia": "Arbitrum Sepolia", "megaethTestnet": "MegaETH testnet"}
    by_slicer = {r["slicer"]: r for r in local}
    by_pair = {(r["network"], r["slicer"]): r for r in public}
    table("corpus-coverage.tex", "Frozen corpus and executed subset. All full-file executions use the three paired outputs of one geometry; size is in bytes.", "tab:corpus", "llrr",
          ["Scope", "Slicer", "Files", "Bytes"],
          [["Qualified corpus",names[s],20,f'{sum(int(r["size_bytes"]) for r in corpus if r["slicer"]==s):,}'] for s in slicers]
          + [["Executed subset",names[s],1,f'{int(by_slicer[s]["size_bytes"]):,}'] for s in slicers],
          "The corpus contains 20 geometries and 60 outputs. Corpus qualification is not protocol execution over 60 files. Identity/Conformance/Feature were executed locally. Public Identity covers the three full files; public Access separately reuses their sealed Demand ciphertext and verifies full-file recovery. Public content-predicate disputes remain unmeasured.")
    table("local-predicates.tex", "Complete local artifact-predicate disputes at 3,072 bytes per chunk. All nine outcomes were Valid; gas is reported in millions (M).", "tab:local", "llrrr",
          ["Slicer", "Predicate", "Deposit (M)", "Process (M)", "Max. process (M)"],
          [[names[r["artifact_key"].split(":")[1]], r["predicate"], f'{int(r["deposit_gas"])/1e6:.3f}', f'{int(r["process_gas"])/1e6:.3f}', f'{int(r["max_process_tx_gas"])/1e6:.3f}'] for r in predicates],
          "Identity reads ciphertext already stored in Demand; its zero deposit increment does not mean publication is free. Conformance and Feature each deposit plaintext for their own dispute. Processing and deposit columns exclude fixed dispute calls.")
    reference_budget = 16777216
    fill_factor = 0.95
    chunk_rows = []
    for r in spectrum:
        variable_gas = int(r["upload_gas"]) + int(r["identity_processing_gas"])
        max_gas = int(r["all_process_tx_max_gas"])
        chunk_rows.append([int(r["chunk_size_bytes"]) // 1024, r["chunk_count"],
                           f'{variable_gas / int(r["size_bytes"]):,.2f}',
                           f'{max_gas / 1e6:.3f}', f'{100 * max_gas / reference_budget:.2f}'])
    table("chunk-selection.tex", "Measured complete-file Identity sweep for the 264,386-byte Cura artifact. All four outcomes were Valid.", "tab:chunk-selection", "rrrrr",
          ["KiB", "Chunks", "Gas/byte", "Max. gas (M)", r"Fill (\%)"], chunk_rows,
          r"Gas/byte includes ciphertext upload plus Identity processing only. Maximum gas is the largest Identity-processing transaction; fill uses the 16,777,216-gas reference screen. All four measured upload and processing profiles also fit the 95\% reference budget. This is not an all-predicate sweep.", placement="!htb")
    operations = [("Ciphertext upload", "depositCiphertextChunk"),
                  ("Conformance deposit", "conformanceDepositChunk"),
                  ("Feature deposit", "featureDepositChunk"),
                  ("Identity processing", "processChunk"),
                  ("Conformance processing", "conformanceProcessChunk"),
                  ("Feature processing", "featureProcessChunk")]
    process_maxima = {}
    for name, operation in operations:
        selected = [r for r in local_transactions if r["operation"] == operation]
        assert len(selected) == 283
        process_maxima[name] = max(int(r["gas_used"]) for r in selected)
    for predicate, operation in [("Identity", "Identity processing"), ("Conformance", "Conformance processing"), ("Feature", "Feature processing")]:
        assert process_maxima[operation] == max(int(r["max_process_tx_gas"]) for r in predicates if r["predicate"] == predicate)
    table("chunk-process-bounds.tex", "Observed per-transaction maxima at the 3-KiB local baseline across the three paired slicer outputs. Each row covers 283 chunk transactions.", "tab:chunk-process-bounds", "lrr",
          ["Process", "Maximum gas", r"Fill (\%)"],
          [[name, f'{value:,}', f'{100 * value / reference_budget:.2f}'] for name, value in process_maxima.items()],
          r"Fill uses the same 16,777,216-gas reference screen. These are observed costs at one chunk size, not per-process maximum feasible chunk sizes or worst-case bounds for arbitrary G-code. Fixed setup, binding and Access calls are excluded.", placement="!htb")
    assert all(max(int(r["all_process_tx_max_gas"]), int(r["upload_tx_max_gas"])) <= fill_factor * reference_budget for r in spectrum)
    rows = []
    for slicer in slicers:
        row = by_slicer[slicer]
        rows.append([names[slicer], f'{int(row["size_bytes"]):,}', row["chunk_count"],
                     2*int(row["chunk_count"])+10,
                     *[f'{int(by_pair[(n,slicer)]["protocol_gas"])/1e6:.3f}' for n in networks]])
    table("public-protocol.tex", "Full public direct-Identity protocol, from posting to dispute completion. Gas excludes two deployments and coordinator setup; three setup transactions must be added to obtain receipt counts.", "tab:public", "lrrrrrr",
          ["Slicer", "Bytes", "Chunks", "Tx", "Sep. (M)", "Arb. (M)", "Mega. (M)"], rows,
          "One complete-file execution per slicer/network pair. The local coordinated multi-predicate setup differs from this direct Identity setup; total lifecycle gas is not a matched local/public comparison.", placement="!htb")
    fee_rows = [[network_names[n] + " (Identity)", "4/4", final["counts_per_network"][n], f'{float(final["fees_native_test_eth_including_smoke_and_setup"][n]):.9f}'] for n in networks]
    fee_rows += [[network_names[n] + " (Access)", "3/3", 39, f'{float(public_access["fees_native_test_eth_including_deployment_and_setup"][n]):.9f}'] for n in networks]
    table("observed-fees.tex", "Observed native test-ETH fees. Identity totals include calibration runs, deployments and original publication; Access totals include new deployments/setup and reuse the existing sealed Demand ciphertext.", "tab:fees", "lrrr",
          ["Network", "Jobs", "Receipts", "Test ETH"],
          fee_rows,
          "Campaign workloads differ, so their totals are not a matched predicate-cost comparison. Access challenge/reveal costs are reported separately in the text. Identity timing caveats and Access readback/pacing remain explicit. Fees are not mainnet price forecasts.", placement="!htb")
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.spines.top": False,
                         "axes.spines.right": False, "pdf.fonttype": 42, "savefig.bbox": "tight"})
    fig, axes = plt.subplots(1, 2, figsize=(7.1, 2.75), layout="constrained")
    chunks = [int(r["chunk_size_bytes"])/1024 for r in spectrum]
    axes[0].plot(chunks, [(int(r["upload_gas"])+int(r["identity_processing_gas"]))/int(r["size_bytes"]) for r in spectrum], "o-", color="#205493")
    axes[0].set(xlabel="Chunk size (KiB)", ylabel="Upload + Identity gas per byte", xticks=chunks)
    axes[0].set_title("(a) Complete 264,386-byte artifact", fontsize=9)
    axes[1].plot(chunks, [int(r["all_process_tx_max_gas"])/1e6 for r in spectrum], "o-", color="#207866")
    axes[1].axhline(reference_budget/1e6, color="#b44a35", linestyle="--", label="Reference screen (16.777 M)")
    axes[1].axhline(fill_factor*reference_budget/1e6, color="#9a711f", linestyle="-.", label="95% budget (15.938 M)")
    axes[1].axvline(3, color="gray", linestyle=":", label="Campaign baseline (3 KiB)")
    axes[1].set(xlabel="Chunk size (KiB)", ylabel="Maximum processing gas (millions)", xticks=chunks)
    axes[1].set_title("(b) Per-transaction constraint", fontsize=9)
    axes[1].legend(fontsize=6.5, loc="lower right")
    fig.savefig(PAPER / "img/d5-chunk-spectrum.pdf"); plt.close(fig)
    fig, axes = plt.subplots(1, 2, figsize=(7.1, 2.9), layout="constrained")
    colors = ["#205493", "#207866", "#b96c29"]
    x = np.arange(3); width = .24
    for i, network in enumerate(networks):
        values = [by_pair[(network,s)] for s in slicers]
        axes[0].bar(x+(i-1)*width, [float(r["upload_vs_anvil_ratio"]) for r in values], width, color=colors[i], label=network_names[network])
        axes[1].bar(x+(i-1)*width, [float(r["processing_vs_anvil_ratio"]) for r in values], width, color=colors[i])
    for ax in axes:
        ax.set_xticks(x, [names[s] for s in slicers]);ax.axhline(1, color="gray", linestyle=":")
    axes[0].set(ylabel="Public / local gas", title="(a) Ciphertext upload")
    axes[1].set(ylabel="Public / local gas", title="(b) Identity processing", ylim=(0,1.25))
    fig.legend(loc="outside lower center", ncol=3, fontsize=8)
    fig.savefig(PAPER / "img/d5-phase-comparison.pdf"); plt.close(fig)
    metrics = {"corpus_files": len(corpus), "corpus_bytes": sum(int(r["size_bytes"]) for r in corpus),
               "measured_bytes": sum(int(r["size_bytes"]) for r in local),
               "public_jobs": final["completed_jobs"], "public_receipts": final["unique_successful_transactions"],
               "public_access_jobs": public_access["completed_jobs"],
               "public_access_receipts": public_access["verified_unique_successful_receipts"],
               "public_access_dispute_gas": {n["network"]: [int(j["access_dispute_gas"]) for j in n["jobs"]] for n in public_access["networks"]},
               "local_suite_passed": suite["passing"], "access_corpus_transactions": len(access["transactions"]),
               "access_dispute_gas": [int(r["total_access_dispute_gas"]) for r in access["artifacts"]],
               "chunk_4_vs_3_gas_saving_percent": 100*(1-int(spectrum[3]["lifecycle_gas"])/int(spectrum[2]["lifecycle_gas"])),
               "chunk_3_headroom_percent": 100*(1-int(spectrum[2]["all_process_tx_max_gas"])/16777216),
               "chunk_4_headroom_percent": 100*(1-int(spectrum[3]["all_process_tx_max_gas"])/16777216)}
    metrics.update({"r1_reference_budget": reference_budget, "r1_fill_factor": fill_factor,
                    "r1_largest_tested_identity_chunk_bytes_within_budget": max(int(r["chunk_size_bytes"]) for r in spectrum if max(int(r["all_process_tx_max_gas"]),int(r["upload_tx_max_gas"])) <= fill_factor*reference_budget),
                    "r1_common_optimum_established": False,
                    "r1_baseline_per_process_max_gas": process_maxima,
                    "r1_chunk_4_vs_3_variable_gas_saving_percent": 100*(1-(int(spectrum[3]["upload_gas"])+int(spectrum[3]["identity_processing_gas"]))/ (int(spectrum[2]["upload_gas"])+int(spectrum[2]["identity_processing_gas"])))})
    extra_figures = []
    extended_r1 = RAW / "r1-selection-2026-10-15"
    if (extended_r1 / "audit.json").exists():
        r1_generator = runpy.run_path(str(Path(__file__).with_name("build-r1-results.py")))
        metrics.update(r1_generator["generate"](table))
        paths += [extended_r1 / name for name in ["audit.json", "process-summary.csv", "case-summary.csv", "campaign.json"]]
        paths.append(Path(__file__).with_name("build-r1-results.py"))
        extra_figures.append("r1-whole-file.pdf")
    r234_script = Path(__file__).with_name("build-r234-results.py")
    metrics.update(runpy.run_path(str(r234_script))["generate"](table))
    paths += [r234_script] + [extended_r1 / "chunk-3072" / name for name in
              ["r1-chunk-selection-transactions.csv", "r1-chunk-selection-predicates.csv", "r1-chunk-selection-summary.csv"]]
    extra_figures.append("r4-dispute-composition.pdf")
    cost_time_script = Path(__file__).with_name("build-cost-time-paper.py")
    metrics.update(runpy.run_path(str(cost_time_script))["generate"](table))
    model_root = STAGE / "results/derived/corpus-cost-time"
    paths += [cost_time_script] + [model_root / name for name in
              ["model.json", "source-map.json", "corpus-predictions.csv", "observed-identity-phases.csv", "observed-access-operations.csv"]]
    extra_figures.append("corpus-cost-time.pdf")
    provenance = {"generator": "code/scripts/build-paper-results.py", "inputs": [
        {"path": p.relative_to(STAGE).as_posix(), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths],
        "metrics": metrics, "rounding": "Tables: gas in millions to 3 decimals; fees to 9 decimals. Raw evidence retains exact integers/decimals.",
        "outputs": [{"path": p.relative_to(STAGE).as_posix(), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                    for p in sorted((PAPER/"tables").glob("*.tex"))] +
                   [{"path": (PAPER/"img"/name).relative_to(STAGE).as_posix(), "sha256": hashlib.sha256((PAPER/"img"/name).read_bytes()).hexdigest()}
                    for name in ["d5-chunk-spectrum.pdf", "d5-phase-comparison.pdf"] + extra_figures] +
                   [{"path": "results/derived/paper/r234-phase-summary.json", "sha256": hashlib.sha256((STAGE / "results/derived/paper/r234-phase-summary.json").read_bytes()).hexdigest()}]}
    (STAGE / "results/derived/paper/source-map.json").write_text(json.dumps(provenance, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
