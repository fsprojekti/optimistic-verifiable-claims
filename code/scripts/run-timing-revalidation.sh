#!/usr/bin/env bash
# Timing revalidation campaign (results/raw-data/timing-revalidation-2026-11-02/PROTOCOL.md).
#
# Usage (from code/):  bash scripts/run-timing-revalidation.sh <sepolia|arbitrumSepolia|megaethTestnet>
#
# One network per invocation; run the three in parallel. Within a network the runs are
# sequential: hinge full path (model), undisputed path, then the validation file(s). A run that
# stops on an RPC/transport error is relaunched from its journal; the relaunch gap (> 120 s) is
# excluded from the step distributions by testnet_model.py. Non-retryable stops end the script.
set -u
NET=$1
CAMPAIGN=timing-revalidation-2026-11-02
DIR=../results/raw-data/$CAMPAIGN
mkdir -p "$DIR"

run() {  # run <name> [VAR=value ...]
  local name=$1; shift
  local log="$DIR/$name.log"
  for attempt in $(seq 1 30); do
    echo "=== launch $attempt $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$log"
    env "$@" OVC_RUN_DIR="$CAMPAIGN/$name" npx hardhat run --network "$NET" scripts/run-testnet-fullpath.js >> "$log" 2>&1
    if tail -1 "$log" | grep -q "complete;"; then
      python -I scripts/export-testnet-journals.py "$DIR/$name" >> "$log" 2>&1
      return 0
    fi
    if tail -40 "$log" | grep -q -E "CHECKPOINT_MISMATCH|PAUSED_FUNDS|REVERTED_TRANSACTION|GAS_CAP|JOURNAL_ERROR|STALE_NONCE|PENDING_EXTERNAL|REORG_REVIEW"; then
      echo "=== stopped: non-retryable error" >> "$log"
      return 1
    fi
    sleep 60
  done
  return 1
}

case $NET in
  sepolia|arbitrumSepolia)
    run "$NET" &&
    run "$NET-accept" OVC_ACCEPT_PATH=1 OVC_ARTIFACT_KEYS=rackstack_hinge:cura &&
    run "$NET-enclosure" OVC_ARTIFACT_KEYS=electronics_enclosure:prusa
    ;;
  megaethTestnet)
    C=OVC_TESTNET_CHUNK_BYTES=31872
    run "$NET-31872" $C &&
    run "$NET-31872-accept" $C OVC_ACCEPT_PATH=1 OVC_ARTIFACT_KEYS=rackstack_hinge:cura &&
    start_a=$(date +%s) &&
    run "$NET-31872-benchy-a" $C OVC_ARTIFACT_KEYS=benchy:prusa &&
    # The second Benchy starts at least 8 h after the first, at another time of day.
    while [ $(( $(date +%s) - start_a )) -lt 28800 ]; do sleep 300; done &&
    run "$NET-31872-benchy-b" $C OVC_ARTIFACT_KEYS=benchy:prusa
    ;;
  *) echo "unknown network $NET"; exit 2 ;;
esac
echo "$NET campaign finished with status $? at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
