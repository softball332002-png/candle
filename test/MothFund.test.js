const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const usd = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;

async function deploy() {
  const [operator, mind, alice, bob] = await ethers.getSigners();
  const food = await ethers.deployContract("MockUSDC");
  const locker = await ethers.deployContract("MockFeeLocker");
  const fund = await ethers.deployContract("MothFund", [food, mind.address, locker, usd(10), usd(25)]);
  await food.mint(operator.address, usd(1000));
  await food.connect(operator).approve(fund, ethers.MaxUint256);
  await food.connect(operator).approve(locker, ethers.MaxUint256);
  await fund.connect(operator).fund(usd(100));
  return { food, locker, fund, operator, mind, alice, bob };
}

describe("MothFund", () => {
  it("harvests its share of fees; anyone can trigger it", async () => {
    const { food, locker, fund, operator, alice } = await loadFixture(deploy);
    await locker.connect(operator).accrue(await fund.getAddress(), await food.getAddress(), usd(5));
    await expect(fund.connect(alice).harvest()).to.emit(fund, "Harvested").withArgs(usd(5), usd(105));
  });

  it("awards in public, only from the mind, with a reason", async () => {
    const { food, fund, mind, alice } = await loadFixture(deploy);
    await expect(fund.connect(alice).award(alice.address, usd(1), "me")).to.be.revertedWithCustomError(fund, "NotMind");
    await expect(fund.connect(mind).award(alice.address, usd(1), "")).to.be.revertedWithCustomError(fund, "BadReason");
    await expect(fund.connect(mind).award(alice.address, usd(4), "drew the moth logo"))
      .to.emit(fund, "Awarded").withArgs(0, alice.address, usd(4), "drew the moth logo");
    expect(await food.balanceOf(alice.address)).to.equal(usd(4));
  });

  it("caps each award and each week", async () => {
    const { fund, mind, alice, bob } = await loadFixture(deploy);
    await expect(fund.connect(mind).award(alice.address, usd(11), "too big")).to.be.revertedWithCustomError(fund, "TooMuch");
    await fund.connect(mind).award(alice.address, usd(10), "a");
    await fund.connect(mind).award(bob.address, usd(10), "b");
    await expect(fund.connect(mind).award(bob.address, usd(6), "c")).to.be.revertedWithCustomError(fund, "TooMuch");
    await time.increase(7 * DAY);
    await fund.connect(mind).award(bob.address, usd(6), "c");
    expect(await fund.totalAwarded()).to.equal(usd(26));
  });
});
