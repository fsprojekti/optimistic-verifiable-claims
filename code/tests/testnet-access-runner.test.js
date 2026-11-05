const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { runAccessJob, publicState, safeError } = require("../scripts/run-testnet-access-v2");
const { chacha20 } = require("./lib/chacha20");
const { PLAINTEXT_DOMAIN, CIPHERTEXT_DOMAIN, segmentedCommitment } = require("./lib/segmented-commitment");

describe("Resumable public Access runner (local integration)", function () {
  this.timeout(60000);
  let directory, options;
  beforeEach(async function () {
    directory=fs.mkdtempSync(path.join(os.tmpdir(),"ovc-access-runner-"));
    const wallet=ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance",[wallet.address,"0x3635c9adc5dea00000"]);
    const plain=Buffer.from("G1 X1 E1\n".repeat(700));
    const hash=crypto.createHash("sha256").update(plain).digest("hex");
    const key=crypto.createHash("sha256").update(`OVC-STAGE03-TESTNET-KEY:${hash}`).digest();
    const nonce=crypto.createHash("sha256").update(`OVC-STAGE03-TESTNET-NONCE:${hash}`).digest().subarray(0,12);
    const cipher=chacha20(plain,key,nonce);
    const demand=await(await ethers.getContractFactory("Demand",wallet)).deploy(3072);await demand.waitForDeployment();
    await(await demand.postDemand(segmentedCommitment(plain,3072,PLAINTEXT_DOMAIN),
      segmentedCommitment(cipher,3072,CIPHERTEXT_DOMAIN),70000000,nonce,plain.length,3072)).wait();
    await(await demand.prepareBinding(1,wallet.address)).wait();
    for(let offset=0;offset<cipher.length;offset+=3072) await(await demand.depositCiphertextChunk(1,cipher.subarray(offset,offset+3072))).wait();
    await(await demand.sealCiphertext(1)).wait();
    options={wallet,paceMs:0,reserveWei:0n,output:path.join(directory,"public.json"),
      privateDirectory:path.join(directory,"private"),reference:{network:"hardhat-local",slicer:"fixture",plaintext:plain,
      artifactSha256:hash,demandAddress:demand.target,demandId:1n,sourceCheckpointSha256:"local-fixture"}};
  });
  afterEach(function () {
    for(const name of fs.readdirSync(path.join(directory,"private"),{withFileTypes:true})) {
      expect(name.isFile()).to.equal(true);fs.unlinkSync(path.join(directory,"private",name.name));
    }
    fs.rmdirSync(path.join(directory,"private"));
    for(const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory,name));fs.rmdirSync(directory);
  });
  it("executes binding, reads every stored chunk and verifies Access; resumes without duplicate transactions",async function () {
    const first=await runAccessJob(hre,options);
    expect(first.outcome).to.equal("Valid");expect(first.summary.successful_transactions).to.equal(13);
    expect(first.summary.ciphertext_chunks_read).to.equal(3);expect(first.summary.complete_artifact_recovered).to.equal(true);
    const before=await ethers.provider.send("eth_getTransactionCount",[options.wallet.address,"latest"]);
    const resumed=await runAccessJob(hre,{...options,wallet:new ethers.Wallet(options.wallet.privateKey,ethers.provider)});
    expect(resumed.outcome).to.equal("Valid");
    expect(await ethers.provider.send("eth_getTransactionCount",[options.wallet.address,"latest"])).to.equal(before);
    const published=fs.readFileSync(options.output,"utf8");
    expect(published).not.to.include('"raw"');expect(published).not.to.include('"private_key"');expect(published).not.to.include('"seed"');
    expect(resumed.summary.timing_interrupted).to.equal(true);
  });
  it("refuses a changed source artifact before sending transactions",async function () {
    await runAccessJob(hre,options);
    const before=await ethers.provider.send("eth_getTransactionCount",[options.wallet.address,"latest"]);
    await expect(runAccessJob(hre,{...options,reference:{...options.reference,artifactSha256:"wrong"}})).to.be.rejectedWith("Artifact hash mismatch");
    expect(await ethers.provider.send("eth_getTransactionCount",[options.wallet.address,"latest"])).to.equal(before);
  });
  it("exports pending operation metadata without signed raw bytes or error payloads",async function () {
    const sanitized=publicState({operations:{pending:{hash:"0x1234",raw:"signed bytes"}}});
    expect(sanitized.operations.pending.raw).to.equal(undefined);
    expect(safeError({shortMessage:"RPC https://private.example/token 0x"+"a".repeat(64)})).not.to.include("private.example");
    // Ensure the cleanup path exists even though this test sends no runner operations.
    fs.mkdirSync(path.join(directory,"private"));
  });
});
