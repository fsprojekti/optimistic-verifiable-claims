const { expect } = require("chai");
const { ethers } = require("hardhat");
const { receiptIdentifier } = require("../scripts/receipt-identifiers");

describe("Transaction-bound protocol identifiers", function () {
  it("uses the posted receipt even when a latest counter differs", async function () {
    const [consumer] = await ethers.getSigners();
    const demand = await ethers.deployContract("Demand", [3072]);
    const args = [ethers.id("plain"), ethers.id("cipher"), 0, "0x000000000000000000000000", 6144, 3072];
    const posted = await (await demand.postDemand(...args)).wait();
    await demand.postDemand(...args);
    expect(await demand.demandCount()).to.equal(2n);
    const id = receiptIdentifier(posted, demand, "DemandPosted", "demandId", "consumer", consumer.address);
    expect(id).to.equal(1n);
    await expect(demand.prepareBinding(0, consumer.address)).to.be.revertedWith("Only consumer");
    await expect(demand.prepareBinding(id, consumer.address)).not.to.be.reverted;
  });

  it("extracts the committed claim ID from its own receipt", async function () {
    const [claimant] = await ethers.getSigners();
    const demand = await ethers.deployContract("Demand", [3072]);
    const identity = await ethers.deployContract("OVCIdentitySegmented", [100000, demand.target]);
    const args = [claimant.address, ethers.id("cipher"), ethers.id("plain"), 0, ethers.id("key")];
    const committed = await (await identity.commitClaim(...args)).wait();
    await identity.commitClaim(...args);
    expect(await identity.claimCount()).to.equal(2n);
    expect(receiptIdentifier(committed, identity, "ClaimCommitted", "claimId", "claimant", claimant.address)).to.equal(1n);
  });

  it("rejects events from another contract or actor and ambiguous receipts", async function () {
    const [consumer, other] = await ethers.getSigners();
    const demand = await ethers.deployContract("Demand", [3072]);
    const posted = await (await demand.postDemand(ethers.id("p"), ethers.id("c"), 0,
      "0x000000000000000000000000", 6144, 3072)).wait();
    const read = (receipt, contract = demand, actor = consumer.address) =>
      receiptIdentifier(receipt, contract, "DemandPosted", "demandId", "consumer", actor);
    expect(() => read(posted, { target: other.address, interface: demand.interface })).to.throw("RECEIPT_IDENTITY");
    expect(() => read(posted, demand, other.address)).to.throw("RECEIPT_IDENTITY");
    expect(() => read({ status: 1, logs: [...posted.logs, ...posted.logs] })).to.throw("RECEIPT_IDENTITY");
  });
});
