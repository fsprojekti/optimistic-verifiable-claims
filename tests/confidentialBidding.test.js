const { expect } = require("chai");
const { ethers } = require("hardhat");

const makeCommitment = (gcode, filamentLength, salt) =>
  ethers.keccak256(
    ethers.solidityPacked(["bytes", "uint64", "bytes32"], [gcode, filamentLength, salt])
  );

const advanceTime = async (seconds) => {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine");
};

describe("ConfidentialBidding", function () {
  async function deployFixture() {
    const [consumer, provider, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ConfidentialBidding");
    const contract = await Factory.deploy();
    return { contract, consumer, provider, other };
  }

  it("accepts a job after unsealing", async function () {
    const { contract, consumer, provider } = await deployFixture();
    const gcode = ethers.toUtf8Bytes("G1 X1 Y1");
    const filamentLength = 1234;
    const salt = ethers.keccak256(ethers.toUtf8Bytes("salt"));
    const commitment = makeCommitment(gcode, filamentLength, salt);
    const encryptedGcode = ethers.toUtf8Bytes("enc-gcode");

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const biddingEnd = now + 60;
    const tx = await contract
      .connect(consumer)
      .createJob(commitment, encryptedGcode, filamentLength, biddingEnd);
    const receipt = await tx.wait();
    const jobId = receipt.logs[0].args.jobId;

    await contract
      .connect(provider)
      .submitBid(jobId, ethers.keccak256(ethers.toUtf8Bytes("bid")), ethers.toUtf8Bytes("pubkey"));
    await advanceTime(120);
    await contract.connect(consumer).selectProvider(jobId, provider.address);
    await contract.connect(consumer).deliverKey(jobId, ethers.toUtf8Bytes("encrypted-key"));

    await contract.connect(provider).providerAccept(jobId);
    const job = await contract.jobs(jobId);
    expect(job.outcome).to.equal(1);
  });

  it("resolves with non-disclosure when the consumer refuses to reveal", async function () {
    const { contract, consumer, provider } = await deployFixture();
    const gcode = ethers.toUtf8Bytes("G1 X1 Y1");
    const filamentLength = 1234;
    const salt = ethers.keccak256(ethers.toUtf8Bytes("salt"));
    const commitment = makeCommitment(gcode, filamentLength, salt);
    const encryptedGcode = ethers.toUtf8Bytes("enc-gcode");

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const biddingEnd = now + 60;
    const tx = await contract
      .connect(consumer)
      .createJob(commitment, encryptedGcode, filamentLength, biddingEnd);
    const receipt = await tx.wait();
    const jobId = receipt.logs[0].args.jobId;

    await contract
      .connect(provider)
      .submitBid(jobId, ethers.keccak256(ethers.toUtf8Bytes("bid")), ethers.toUtf8Bytes("pubkey"));
    await advanceTime(120);
    await contract.connect(consumer).selectProvider(jobId, provider.address);
    await contract.connect(consumer).deliverKey(jobId, ethers.toUtf8Bytes("encrypted-key"));

    await contract.connect(provider).providerDispute(jobId);
    await contract.connect(consumer).consumerRefuseDisclosure(jobId);

    const job = await contract.jobs(jobId);
    expect(job.outcome).to.equal(2);
  });

  it("validates a correct reveal after a dispute", async function () {
    const { contract, consumer, provider } = await deployFixture();
    const gcode = ethers.toUtf8Bytes("G1 X1 Y1");
    const filamentLength = 1234;
    const salt = ethers.keccak256(ethers.toUtf8Bytes("salt"));
    const commitment = makeCommitment(gcode, filamentLength, salt);
    const encryptedGcode = ethers.toUtf8Bytes("enc-gcode");

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const biddingEnd = now + 60;
    const tx = await contract
      .connect(consumer)
      .createJob(commitment, encryptedGcode, filamentLength, biddingEnd);
    const receipt = await tx.wait();
    const jobId = receipt.logs[0].args.jobId;

    await contract
      .connect(provider)
      .submitBid(jobId, ethers.keccak256(ethers.toUtf8Bytes("bid")), ethers.toUtf8Bytes("pubkey"));
    await advanceTime(120);
    await contract.connect(consumer).selectProvider(jobId, provider.address);
    await contract.connect(consumer).deliverKey(jobId, ethers.toUtf8Bytes("encrypted-key"));

    await contract.connect(provider).providerDispute(jobId);
    await contract.connect(consumer).consumerReveal(jobId, gcode, filamentLength, salt);

    const job = await contract.jobs(jobId);
    expect(job.outcome).to.equal(4);
  });

  it("marks an invalid reveal when the commitment does not match", async function () {
    const { contract, consumer, provider, other } = await deployFixture();
    const gcode = ethers.toUtf8Bytes("G1 X1 Y1");
    const filamentLength = 1234;
    const salt = ethers.keccak256(ethers.toUtf8Bytes("salt"));
    const commitment = makeCommitment(gcode, filamentLength, salt);
    const encryptedGcode = ethers.toUtf8Bytes("enc-gcode");

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const biddingEnd = now + 60;
    const tx = await contract
      .connect(consumer)
      .createJob(commitment, encryptedGcode, filamentLength, biddingEnd);
    const receipt = await tx.wait();
    const jobId = receipt.logs[0].args.jobId;

    await contract
      .connect(provider)
      .submitBid(jobId, ethers.keccak256(ethers.toUtf8Bytes("bid")), ethers.toUtf8Bytes("pubkey"));
    await advanceTime(120);
    await contract.connect(consumer).selectProvider(jobId, provider.address);
    await contract.connect(consumer).deliverKey(jobId, ethers.toUtf8Bytes("encrypted-key"));

    await expect(contract.connect(other).providerDispute(jobId)).to.be.revertedWith(
      "Only selected provider"
    );

    await contract.connect(provider).providerDispute(jobId);
    await contract
      .connect(consumer)
      .consumerReveal(jobId, gcode, filamentLength + 1, ethers.keccak256(ethers.toUtf8Bytes("bad")));

    const job = await contract.jobs(jobId);
    expect(job.outcome).to.equal(3);
  });
});
