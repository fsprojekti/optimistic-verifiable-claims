// One worker per allowlisted testnet; jobs on a given chain always run sequentially.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { saveJson } = require("./transaction-journal");

const codeRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(codeRoot, "../../..");
const network = process.argv[2];
if (!["sepolia", "arbitrumSepolia", "megaethTestnet"].includes(network)) {
  throw new Error("Choose sepolia, arbitrumSepolia or megaethTestnet");
}
const campaignRoot = path.resolve(process.argv[3] || path.join(codeRoot,
  "../results/raw-data/duration-campaigns/d5-weekend-2026-10-09"));
const directory = path.join(campaignRoot, network);
const canonicalRoot = path.join(projectRoot, "_local-tools/ovc-d5-canonical-corpus");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const artifacts = [
  { slicer: "cura", bytes: 264386, sha256: "f1a51107fda5819a776de26b6068be1e577111bb2e84eb27341592842d582c33" },
  { slicer: "orca", bytes: 280935, sha256: "d9c608650aa0a780a6a6d283107329ce9a47ee7f08b985ad4ee81ad6f53e879b" },
  { slicer: "prusa", bytes: 316712, sha256: "3961ee85ee32938b17151ddd37e2ed800b89801b185b5ace76f48ff3b18e8761" },
];
const jobs = [
  { id: "smoke-cura-6144", artifact: artifacts[0], bytes: 6144 },
  ...artifacts.map(artifact => ({ id: `full-${artifact.slicer}`, artifact, bytes: artifact.bytes })),
];
const settings = { chunk_bytes: 3072, pacing_ms: 1000, reserve_test_eth: "0.005",
  scope: "Identity disputes over a two-chunk excerpt and three complete paired slicer artifacts" };
const statusPath = path.join(directory, "status.json");
const lockPath = path.join(directory, "worker.lock");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let status;
let ownsLock = false;

function report(state, extra = {}) {
  Object.assign(status, { state, updated_at_utc: new Date().toISOString(), ...extra });
  saveJson(statusPath, status);
  console.log(`${status.updated_at_utc} ${network} ${state} ${status.current_job || ""}`);
}

function launch(job, checkpoint, artifactPath) {
  return new Promise((resolve, reject) => {
    const output = fs.openSync(path.join(directory, `${job.id}.log`), "a");
    const child = spawn(process.execPath, [require.resolve("hardhat/internal/cli/cli"),
      "run", "scripts/run-testnet-identity.js", "--network", network], {
      cwd: codeRoot, windowsHide: true, stdio: ["ignore", output, output],
      env: { ...process.env, OVC_TESTNET_CHUNK_BYTES: String(settings.chunk_bytes),
        OVC_TESTNET_ARTIFACT_BYTES: String(job.bytes), OVC_TESTNET_ARTIFACT: artifactPath,
        OVC_TESTNET_DELAY_MS: String(settings.pacing_ms), OVC_TESTNET_CHECKPOINT: checkpoint,
        OVC_TESTNET_RESERVE_ETH: settings.reserve_test_eth },
    });
    report("running", { child_pid: child.pid });
    child.once("error", error => { fs.closeSync(output); reject(error); });
    child.once("exit", code => { fs.closeSync(output); resolve(code); });
  });
}

async function main() {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(lockPath)) {
    const old = Number(fs.readFileSync(lockPath, "utf8"));
    let alive = true;
    try { process.kill(old, 0); } catch { alive = false; }
    if (alive) throw new Error(`Worker already running: ${old}`);
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  ownsLock = true;
  status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, "utf8")) : {
    network, created_at_utc: new Date().toISOString(), settings, completed_jobs: [], attempts: {},
    deadline_utc: new Date(Date.now() + 72 * 3600000).toISOString(),
  };
  if (JSON.stringify(status.settings) !== JSON.stringify(settings)) throw Error("Campaign settings changed");
  report("starting", { worker_pid: process.pid, jobs: jobs.map(j => ({ id: j.id, bytes: j.bytes })) });
  const sources = ["run-testnet-identity.js", "transaction-journal.js", "run-testnet-campaign.js"];
  const sourceHashes = Object.fromEntries(sources.map(name => [name, hash(fs.readFileSync(path.join(__dirname, name)))]));
  const sourcePath = path.join(directory, "runner-source-hashes.json");
  if (fs.existsSync(sourcePath) && JSON.stringify(JSON.parse(fs.readFileSync(sourcePath))) !== JSON.stringify(sourceHashes)) {
    throw Error("Runner sources changed; review before resuming campaign");
  }
  saveJson(sourcePath, sourceHashes);
  for (const job of jobs) {
    const artifactPath = path.join(canonicalRoot, "gcode", job.artifact.slicer, "rackstack_hinge.gcode");
    const data = fs.readFileSync(artifactPath);
    if (data.length !== job.artifact.bytes || hash(data) !== job.artifact.sha256) throw Error("Corpus hash mismatch");
    const checkpoint = path.join(directory, `${job.id}.checkpoint.json`);
    for (;;) {
      const saved = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint)) : null;
      if (saved?.outcome === "Valid" && saved?.summary_path && fs.existsSync(saved.summary_path)) {
        if (!status.completed_jobs.some(j => j.id === job.id)) {
          status.completed_jobs.push({ id: job.id, summary_path: saved.summary_path,
            completed_at_utc: saved.completed_at_utc, launches: saved.launches });
        }
        report("job_complete", { current_job: job.id, child_pid: null });
        break;
      }
      if (Date.now() >= Date.parse(status.deadline_utc)) {
        report("paused_deadline", { current_job: job.id, child_pid: null });
        return;
      }
      status.attempts[job.id] = (status.attempts[job.id] || 0) + 1;
      report("launching", { current_job: job.id });
      const exitCode = await launch(job, checkpoint, artifactPath);
      if (exitCode === 0) continue;
      if (exitCode === 4) {
        report("needs_review", { last_exit_code: exitCode, child_pid: null });
        return;
      }
      const wait = exitCode === 2 ? 15 * 60000 : 2 * 60000;
      report(exitCode === 2 ? "waiting_for_test_funds" : "waiting_for_rpc", {
        last_exit_code: exitCode, child_pid: null, retry_at_utc: new Date(Date.now() + wait).toISOString(),
      });
      await sleep(wait);
    }
  }
  report("complete", { current_job: null, child_pid: null, completed_at_utc: new Date().toISOString() });
}

main().catch(error => {
  console.error(String(error.message).slice(0, 500));
  if (status) report("needs_review", { error: String(error.message).slice(0, 500) });
  process.exitCode = 1;
}).finally(() => { if (ownsLock && fs.existsSync(lockPath)) fs.unlinkSync(lockPath); });
