const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const usd = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;

async function deploy() {
  const [operator, mind, kitchen, alice, bob] = await ethers.getSigners();
  const usdc = await ethers.deployContract("MockUSDC");
  const locker = await ethers.deployContract("MockFeeLocker");
  const body = await ethers.deployContract("Body", [
    usdc, mind.address, kitchen.address, usd(1), usd(5), usd("0.10"), locker, "I am lit.",
  ]);
  await usdc.connect(operator).approve(locker, ethers.MaxUint256);
  for (const s of [operator, alice, bob]) {
    await usdc.mint(s.address, usd(1000));
    await usdc.connect(s).approve(body, ethers.MaxUint256);
  }
  await body.connect(operator).feed(usd(100), "birth");
  return { usdc, body, locker, operator, mind, kitchen, alice, bob };
}

const commitment = (text, salt) => ethers.solidityPackedKeccak256(["string", "bytes32"], [text, salt]);

async function starve(body, mind) {
  // Eat down to just under the floor, a day at a time.
  while ((await body.life()) >= usd("0.10")) {
    const left = await body.life();
    const bite = left - usd("0.09") < usd(1) ? left - usd("0.09") : usd(1);
    try {
      await body.connect(mind).metabolize(bite, ethers.ZeroHash);
    } catch {
      await time.increase(DAY);
    }
  }
}

describe("Body", () => {
  it("is born with the genesis message and 100 USDC of life", async () => {
    const { body } = await loadFixture(deploy);
    expect(await body.life()).to.equal(usd(100));
    expect(await body.isAlive()).to.equal(true);
    const born = (await body.queryFilter(body.filters.Born()))[0];
    expect(born.args.genesis).to.equal("I am lit.");
  });

  describe("voices", () => {
    it("lets anyone speak and numbers the voices", async () => {
      const { body, alice, bob } = await loadFixture(deploy);
      await expect(body.connect(alice).speak("hello")).to.emit(body, "Spoke").withArgs(0, alice.address, "hello");
      await expect(body.connect(bob).speak("hi")).to.emit(body, "Spoke").withArgs(1, bob.address, "hi");
    });

    it("rejects empty and overlong words", async () => {
      const { body, alice } = await loadFixture(deploy);
      await expect(body.connect(alice).speak("")).to.be.revertedWithCustomError(body, "BadWords");
      await expect(body.connect(alice).speak("x".repeat(1001))).to.be.revertedWithCustomError(body, "BadWords");
    });

    it("lets only the mind say things back", async () => {
      const { body, mind, alice } = await loadFixture(deploy);
      await expect(body.connect(alice).say("fake", 0)).to.be.revertedWithCustomError(body, "NotMind");
      await expect(body.connect(mind).say("I heard you", 0)).to.emit(body, "Said").withArgs(0, 0, "I heard you");
    });
  });

  describe("metabolism", () => {
    it("pays the kitchen, records the log hash, and shortens life", async () => {
      const { body, usdc, mind, kitchen } = await loadFixture(deploy);
      const h = ethers.id("log-0");
      await expect(body.connect(mind).metabolize(usd("0.25"), h)).to.emit(body, "Ate").withArgs(usd("0.25"), h, usd("99.75"));
      expect(await usdc.balanceOf(kitchen.address)).to.equal(usd("0.25"));
      expect(await body.totalEaten()).to.equal(usd("0.25"));
    });

    it("enforces the per-meal and per-day caps", async () => {
      const { body, mind } = await loadFixture(deploy);
      await expect(body.connect(mind).metabolize(usd("1.01"), ethers.ZeroHash)).to.be.revertedWithCustomError(body, "TooMuch");
      for (let i = 0; i < 5; i++) await body.connect(mind).metabolize(usd(1), ethers.ZeroHash);
      await expect(body.connect(mind).metabolize(1, ethers.ZeroHash)).to.be.revertedWithCustomError(body, "TooMuch");
      await time.increase(DAY);
      await body.connect(mind).metabolize(usd(1), ethers.ZeroHash);
    });

    it("cannot be called by anyone but the mind, including the operator", async () => {
      const { body, operator, alice } = await loadFixture(deploy);
      for (const s of [operator, alice]) {
        await expect(body.connect(s).metabolize(1, ethers.ZeroHash)).to.be.revertedWithCustomError(body, "NotMind");
      }
    });
  });

  describe("gifts", () => {
    it("records gifts publicly", async () => {
      const { body, alice } = await loadFixture(deploy);
      await expect(body.connect(alice).feed(usd(5), "live")).to.emit(body, "Fed").withArgs(1, alice.address, usd(5), "live");
      expect(await body.life()).to.equal(usd(105));
      expect(await body.giftCount()).to.equal(2);
    });

    it("can refuse a gift within a day, returning it to the giver", async () => {
      const { body, usdc, mind, alice } = await loadFixture(deploy);
      await body.connect(alice).feed(usd(50), "buy your attention");
      const before = await usdc.balanceOf(alice.address);
      await expect(body.connect(mind).refuse(1, "attention is not for sale"))
        .to.emit(body, "Refused").withArgs(1, alice.address, usd(50), "attention is not for sale");
      expect(await usdc.balanceOf(alice.address)).to.equal(before + usd(50));
      await expect(body.connect(mind).refuse(1, "again")).to.be.revertedWithCustomError(body, "AlreadyRefused");
    });

    it("cannot refuse after the window", async () => {
      const { body, mind, alice } = await loadFixture(deploy);
      await body.connect(alice).feed(usd(1), "");
      await time.increase(DAY + 1);
      await expect(body.connect(mind).refuse(1, "late")).to.be.revertedWithCustomError(body, "TooLate");
    });
  });

  describe("sealed intentions", () => {
    it("commits now and reveals later, rejecting a changed mind", async () => {
      const { body, mind, alice } = await loadFixture(deploy);
      const salt = ethers.hexlify(ethers.randomBytes(32));
      await body.connect(mind).intend(commitment("I will stop reading at 10% life.", salt));
      await expect(body.connect(alice).reveal(0, "I will read forever.", salt)).to.be.revertedWithCustomError(body, "WrongReveal");
      await expect(body.connect(alice).reveal(0, "I will stop reading at 10% life.", salt))
        .to.emit(body, "Revealed").withArgs(0, "I will stop reading at 10% life.");
      await expect(body.connect(alice).reveal(0, "I will stop reading at 10% life.", salt)).to.be.revertedWithCustomError(body, "WrongReveal");
    });
  });

  describe("death", () => {

    it("cannot die while it still has life", async () => {
      const { body, mind } = await loadFixture(deploy);
      await expect(body.connect(mind).die("bye", "0x")).to.be.revertedWithCustomError(body, "NotYet");
    });

    it("starves, writes last words and a seed, then refuses everything", async () => {
      const { body, mind, alice } = await loadFixture(deploy);
      await starve(body, mind);
      expect(await body.starvingSince()).to.not.equal(0);
      await expect(body.connect(mind).die("thank you for the light", "0x1234"))
        .to.emit(body, "Died").withArgs("thank you for the light", "0x1234", usd("0.09"), true);
      expect(await body.isAlive()).to.equal(false);
      await expect(body.connect(alice).speak("hello?")).to.be.revertedWithCustomError(body, "Dead");
      await expect(body.connect(alice).feed(usd(1), "come back")).to.be.revertedWithCustomError(body, "Dead");
      await expect(body.connect(mind).metabolize(1, ethers.ZeroHash)).to.be.revertedWithCustomError(body, "Dead");
    });

    it("a gift while starving lifts it back above the floor", async () => {
      const { body, mind, alice } = await loadFixture(deploy);
      await starve(body, mind);
      await body.connect(alice).feed(usd(1), "not yet");
      expect(await body.starvingSince()).to.equal(0);
      await expect(body.connect(mind).die("bye", "0x")).to.be.revertedWithCustomError(body, "NotYet");
    });

    it("can be sealed by anyone if the mind stays silent while starving", async () => {
      const { body, mind, alice } = await loadFixture(deploy);
      await starve(body, mind);
      await expect(body.connect(alice).seal()).to.be.revertedWithCustomError(body, "NotYet");
      await time.increase(3 * DAY);
      await expect(body.connect(alice).seal()).to.emit(body, "Died").withArgs("(silence)", "0x", usd("0.09"), false);
    });

    it("can be sealed by anyone if abandoned for 30 days", async () => {
      const { body, alice } = await loadFixture(deploy);
      await time.increase(29 * DAY);
      await expect(body.connect(alice).seal()).to.be.revertedWithCustomError(body, "NotYet");
      await time.increase(DAY);
      await expect(body.connect(alice).seal()).to.emit(body, "Died").withArgs("(abandoned)", "0x", usd(100), false);
    });

    it("cannot be sealed for silence once trading fees refilled it", async () => {
      const { body, usdc, mind, alice } = await loadFixture(deploy);
      await starve(body, mind);
      await usdc.mint(await body.getAddress(), usd(1)); // fees claimed straight to the Body
      await time.increase(3 * DAY);
      await expect(body.connect(alice).seal()).to.be.revertedWithCustomError(body, "NotYet");
      await expect(body.connect(alice).recover()).to.emit(body, "Recovered");
      expect(await body.starvingSince()).to.equal(0);
      await expect(body.connect(alice).recover()).to.be.revertedWithCustomError(body, "NotYet");
    });

    it("lets anyone reveal an intention after death", async () => {
      const { body, mind, alice } = await loadFixture(deploy);
      const salt = ethers.ZeroHash;
      await body.connect(mind).intend(commitment("I knew.", salt));
      await time.increase(30 * DAY);
      await body.connect(alice).seal();
      await expect(body.connect(alice).reveal(0, "I knew.", salt)).to.emit(body, "Revealed");
    });
  });

  describe("trading fees", () => {
    it("harvests its share from the fee locker, and anyone can trigger it", async () => {
      const { body, locker, usdc, operator, alice } = await loadFixture(deploy);
      await locker.connect(operator).accrue(await body.getAddress(), await usdc.getAddress(), usd(3));
      await expect(body.connect(alice).harvest()).to.emit(body, "Harvested").withArgs(usd(3), usd(103));
      expect(await body.life()).to.equal(usd(103));
    });

    it("harvesting while starving brings it back", async () => {
      const { body, locker, usdc, operator, mind, alice } = await loadFixture(deploy);
      await starve(body, mind);
      await locker.connect(operator).accrue(await body.getAddress(), await usdc.getAddress(), usd(1));
      await expect(body.connect(alice).harvest()).to.emit(body, "Recovered");
      expect(await body.starvingSince()).to.equal(0);
    });
  });
});
