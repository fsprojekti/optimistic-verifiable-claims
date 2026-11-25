#!/usr/bin/env bash
# Conformance testnet campaign (results/raw-data/conformance-testnet-2026-11-25/PROTOCOL.md).
#
# Usage (from code/):  OVC_CORPUS_ROOT=<exact corpus> bash scripts/run-conformance-testnet.sh <sepolia|arbitrumSepolia|megaethTestnet>
#
# One network per invocation; run the three in parallel. A run that stops on an RPC/transport
# error is relaunched from its journal; the relaunch gap (> 120 s) is excluded from the step
# distributions by testnet_model.py. Non-retryable stops end the script.
set -u
NET=$1
CAMPAIGN=conformance-testnet-2026-11-25
DIR=../results/raw-data/$CAMPAIGN
mkdir -p "$DIR"
: "${OVC_CORPUS_ROOT:?set OVC_CORPUS_ROOT to the exact corpus}"

run() {  # run <name> [VAR=value ...]
  local name=$1; shift
  local log="$DIR/$name.log"
  for attempt in $(seq 1 30); do
    echo "=== launch $attempt $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$log"
    env "$@" OVC_CONFORMANCE_ONLY=1 OVC_RUN_DIR="$CAMPAIGN/$name" npx hardhat run --network "$NET" scripts/run-testnet-fullpath.js >> "$log" 2>&1
    if tail -1 "$log" | grep -q "complete;"; then
      python -I scripts/export-testnet-journals.py "$DIR/$name" >> "$log" 2>&1
      return 0
    fi
    if tail -40 "$log" | grep -q -E "CHECKPOINT_MISMATCH|PAUSED_FUNDS|REVERTED_TRANSACTION|GAS_CAP|JOURNAL_ERROR|STALE_NONCE|PENDING_EXTERNAL|REORG_REVIEW|RECEIPT_IDENTITY|not Valid|does not match"; then
      echo "=== stopped: non-retryable error" >> "$log"
      return 1
    fi
    sleep 60
  done
  return 1
}

case $NET in
  sepolia|arbitrumSepolia)
    run "$NET"
    ;;
  megaethTestnet)
    C=OVC_TESTNET_CHUNK_BYTES=31872
    run "$NET-31872" $C &&
    run "$NET-31872-benchy" $C OVC_ARTIFACT_KEYS=benchy:prusa
    ;;
  *) echo "unknown network $NET"; exit 2 ;;
esac
echo "$NET campaign finished with status $? at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
