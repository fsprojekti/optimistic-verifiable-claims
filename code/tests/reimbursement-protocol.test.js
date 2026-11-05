const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const {
  PLAINTEXT_DOMAIN,
  segmentedCommitment,
} = require("./lib/segmented-commitment");

const ZERO = ethers.ZeroHash;
const WINDOW = 5;
const F = ethers.parseEther("0.01");

describe("Stage 03 conditional witness reimbursement", function () {
  let consumer, provider, executor, contract;

  beforeEach(async function () {
    [consumer, provider, executor] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("OVCConformanceSegmented");
    contract = await Factory.deploy(WINDOW);
    await contract.waitForDeployment();
  });

  async function createClaim(chunks, reimbursement = F) {
    const bytes = chunks.reduce((n, chunk) => n + ethers.getBytes(chunk).length, 0);
    const chunkSize = ethers.getBytes(chunks[0]).length;
    const artifact = ethers.concat(chunks);
    await contract.connect(consumer).commitClaim(
      provider.address,
      segmentedCommitment(artifact, chunkSize, PLAINTEXT_DOMAIN),
      ZERO,
      0,
      ZERO
    );
    const claimId = await contract.claimCount();
    await contract.connect(consumer).configureWitnessTerms(claimId, bytes, reimbursement);
    await contract.connect(consumer).configureDepositFormat(
      claimId, PLAINTEXT_DOMAIN, bytes, chunkSize
    );
    return claimId;
  }

  it("requires Provider to escrow the fixed amount", async function () {
    const chunks = [ethers.toUtf8Bytes("G0 X1\n")];
    const claimId = await createClaim(chunks);

    await expect(contract.connect(provider).disputeClaim(claimId))
      .to.be.revertedWith("Incorrect reimbursement escrow");
    await expect(contract.connect(provider).disputeClaim(claimId, { value: F - 1n }))
      .to.be.revertedWith("Incorrect reimbursement escrow");

    await contract.connect(provider).disputeClaim(claimId, { value: F });
    expect(await contract.reimbursementEscrow(claimId)).to.equal(F);
  });

  it("credits Consumer after a Valid verdict and permits withdrawal", async function () {
    const chunks = [ethers.toUtf8Bytes("G0 X1\n")];
    const claimId = await createClaim(chunks);
    await contract.connect(provider).disputeClaim(claimId, { value: F });
    await contract.connect(consumer).depositChunk(claimId, chunks[0]);
    await contract.connect(consumer).startAdjudication(claimId);

    // Predicate processing and finalization are deliberately permissionless.
    await contract.connect(executor).processChunk(claimId);
    await contract.connect(executor).finalizeAdjudication(claimId);

    expect((await contract.claims(claimId)).outcome).to.equal(2n); // Valid
    expect(await contract.reimbursementEscrow(claimId)).to.equal(0);
    expect(await contract.reimbursementCredits(consumer.address)).to.equal(F);
    expect(await ethers.provider.getBalance(contract.target)).to.equal(F);

    await contract.connect(consumer).withdrawReimbursement();
    expect(await contract.reimbursementCredits(consumer.address)).to.equal(0);
    expect(await ethers.provider.getBalance(contract.target)).to.equal(0);
  });

  it("returns escrow to Provider after an Incorrect verdict", async function () {
    const chunks = [ethers.toUtf8Bytes("M82\n")];
    const claimId = await createClaim(chunks);
    await contract.connect(provider).disputeClaim(claimId, { value: F });
    await contract.connect(consumer).depositChunk(claimId, chunks[0]);
    await contract.connect(consumer).startAdjudication(claimId);
    await contract.connect(executor).processChunk(claimId);
    await contract.connect(executor).finalizeAdjudication(claimId);

    expect((await contract.claims(claimId)).outcome).to.equal(4n); // Incorrect
    expect(await contract.reimbursementCredits(provider.address)).to.equal(F);
  });

  it("returns escrow to Provider when Consumer withholds", async function () {
    const chunks = [ethers.toUtf8Bytes("G1 X1\n")];
    const claimId = await createClaim(chunks);
    await contract.connect(provider).disputeClaim(claimId, { value: F });
    await network.provider.send("hardhat_mine", ["0x6"]);
    await contract.connect(executor).resolveWithheld(claimId);

    expect((await contract.claims(claimId)).outcome).to.equal(5n); // Withheld
    expect(await contract.reimbursementCredits(provider.address)).to.equal(F);
  });

  it("enforces the bound witness length", async function () {
    const chunks = [ethers.toUtf8Bytes("G0\n")];
    const claimId = await createClaim(chunks);
    await contract.connect(provider).disputeClaim(claimId, { value: F });

    await expect(
      contract.connect(consumer).depositChunk(claimId, ethers.toUtf8Bytes("G0 X123\n"))
    ).to.be.revertedWith("Incorrect chunk length");
  });

  it("keeps an unprocessed adjudication unresolved with escrow locked", async function () {
    const chunks = [ethers.toUtf8Bytes("G0 X1\n")];
    const claimId = await createClaim(chunks);
    await contract.connect(provider).disputeClaim(claimId, { value: F });
    await contract.connect(consumer).depositChunk(claimId, chunks[0]);
    await contract.connect(consumer).startAdjudication(claimId);
    await network.provider.send("hardhat_mine", ["0x20"]);

    expect((await contract.claims(claimId)).state).to.equal(4n); // Adjudicating
    expect((await contract.claims(claimId)).outcome).to.equal(0n); // None
    expect(await contract.reimbursementEscrow(claimId)).to.equal(F);
    expect(await contract.reimbursementCredits(consumer.address)).to.equal(0);
    expect(await contract.reimbursementCredits(provider.address)).to.equal(0);
  });
});
