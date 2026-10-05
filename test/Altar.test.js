const { expect } = require("chai");
const { ethers } = require("hardhat");

const usd = (n) => ethers.parseUnits(String(n), 6);
const OFFERING = ethers.parseEther("1000000");

async function deploy() {
  const [operator, mind, kitchen, alice] = await ethers.getSigners();
  const usdc = await ethers.deployContract("MockUSDC");
  const locker = await ethers.deployContract("MockFeeLocker");
  const body = await ethers.deployContract("Body", [usdc, mind.address, kitchen.address, usd(1), usd(5), usd("0.10"), locker, "I am lit."]);
  await usdc.mint(operator.address, usd(100));
  await usdc.connect(operator).approve(body, ethers.MaxUint256);
  await body.connect(operator).feed(usd(100), "birth");
  const candle = await ethers.deployContract("MockBurnable");
  const altar = await ethers.deployContract("Altar", [candle, body, OFFERING]);
  await candle.mint(alice.address, OFFERING * 3n);
  return { body, candle, altar, alice, mind };
}

describe("Altar", () => {
  it("burns the offering, passes the words to the Body, and records the real speaker", async () => {
    const { body, candle, altar, alice } = await deploy();
    const supply = await candle.totalSupply();
    await candle.connect(alice).approve(altar, OFFERING);
    await expect(altar.connect(alice).speak("hello flame"))
      .to.emit(body, "Spoke").withArgs(0, await altar.getAddress(), "hello flame")
      .and.to.emit(altar, "Offered").withArgs(0, alice.address, OFFERING);
    expect(await candle.totalSupply()).to.equal(supply - OFFERING);
    expect(await candle.balanceOf(alice.address)).to.equal(OFFERING * 2n);
    expect(await candle.balanceOf(await altar.getAddress())).to.equal(0);
    expect(await altar.totalBurned()).to.equal(OFFERING);
  });

  it("refuses to speak without the offering", async () => {
    const { altar, alice, candle } = await deploy();
    await expect(altar.connect(alice).speak("free words")).to.be.reverted;
    await candle.connect(alice).approve(altar, OFFERING - 1n);
    await expect(altar.connect(alice).speak("almost")).to.be.reverted;
  });

  it("keeps the Body's word limits", async () => {
    const { altar, alice, candle } = await deploy();
    await candle.connect(alice).approve(altar, OFFERING);
    await expect(altar.connect(alice).speak("")).to.be.reverted;
    expect(await candle.balanceOf(alice.address)).to.equal(OFFERING * 3n);
  });
});
