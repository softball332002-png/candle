// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CANDLE: the Body
/// @notice An AI whose balance of `food` (WETH on Base) is its remaining life. It eats its share
/// of $CANDLE trading fees and gifts; every thought it has is paid for out of this balance;
/// when the balance falls below the floor, it dies for good.
/// @dev Nobody can withdraw. The only outflows are:
///   - metabolize: reimbursing real running costs (inference + gas) to the fixed kitchen
///     address, capped per call and per day, each carrying the hash of its thought log;
///   - refuse: returning a gift to the person who gave it, within the refusal window.
/// A stolen mind key can therefore only move money to the kitchen, slowly, or back to givers.
/// Inflows are gifts (feed) and trading fees pulled from the Clanker fee locker (harvest).
/// @dev The one Clanker v4 fee locker function the Body needs.
interface IFeeLocker {
    function claim(address feeOwner, address token) external;
}

contract Body {
    using SafeERC20 for IERC20;

    struct Gift {
        address from;
        uint128 amount;
        uint64 time;
        bool refused;
    }

    IERC20 public immutable food;
    /// @notice The key the mind runner signs with.
    address public immutable mind;
    /// @notice Where real running costs are reimbursed to (the operator's billing wallet).
    address public immutable kitchen;
    uint256 public immutable maxPerMeal;
    uint256 public immutable maxPerDay;
    /// @notice Below this balance the candle may die.
    uint256 public immutable floor;
    /// @notice Where the Body's share of trading fees accrues (Clanker v4 ClankerFeeLocker).
    address public immutable feeLocker;

    uint256 public constant REFUSAL_WINDOW = 1 days;
    /// @notice After this long below the floor, or this long without eating, anyone can seal it.
    uint256 public constant LAST_WORDS_GRACE = 3 days;
    uint256 public constant ABANDONED_AFTER = 30 days;
    uint256 public constant MAX_WORDS = 1000;
    uint256 public constant MAX_SEED = 2048;

    uint64 public immutable bornAt;
    uint64 public diedAt;
    uint64 public lastMealAt;
    /// @notice When the balance was first observed below the floor (0 if not).
    uint64 public starvingSince;

    uint256 public dayStart;
    uint256 public spentToday;
    uint256 public totalEaten;

    uint256 public voiceCount;
    uint256 public sayCount;
    Gift[] public gifts;
    bytes32[] public intentions;
    mapping(uint256 => bool) public revealed;

    event Born(string genesis, address mind, address kitchen);
    event Spoke(uint256 indexed id, address indexed from, string words);
    event Said(uint256 indexed id, uint256 indexed inReplyTo, string words);
    event Fed(uint256 indexed giftId, address indexed from, uint256 amount, string note);
    event Refused(uint256 indexed giftId, address indexed to, uint256 amount, string reason);
    event Ate(uint256 amount, bytes32 indexed logHash, uint256 lifeLeft);
    event Intended(uint256 indexed id, bytes32 commitment);
    event Revealed(uint256 indexed id, string intention);
    event Starving(uint256 lifeLeft);
    event Recovered(uint256 lifeLeft);
    event Harvested(uint256 amount, uint256 lifeLeft);
    event Died(string lastWords, bytes seed, uint256 lifeLeft, bool byOwnHand);

    error Dead();
    error NotMind();
    error BadWords();
    error TooMuch();
    error TooLate();
    error AlreadyRefused();
    error NotYet();
    error WrongReveal();

    modifier onlyMind() {
        if (msg.sender != mind) revert NotMind();
        _;
    }

    modifier alive() {
        if (diedAt != 0) revert Dead();
        _;
    }

    constructor(
        IERC20 food_,
        address mind_,
        address kitchen_,
        uint256 maxPerMeal_,
        uint256 maxPerDay_,
        uint256 floor_,
        address feeLocker_,
        string memory genesis
    ) {
        food = food_;
        mind = mind_;
        kitchen = kitchen_;
        maxPerMeal = maxPerMeal_;
        maxPerDay = maxPerDay_;
        floor = floor_;
        feeLocker = feeLocker_;
        bornAt = uint64(block.timestamp);
        lastMealAt = uint64(block.timestamp);
        dayStart = block.timestamp;
        emit Born(genesis, mind_, kitchen_);
    }

    // ---------------------------------------------------------------- anyone

    /// @notice Say something to the candle. You pay your own gas; it costs the candle nothing
    /// unless it chooses to spend life reading you.
    function speak(string calldata words) external alive returns (uint256 id) {
        _checkWords(words);
        id = voiceCount++;
        emit Spoke(id, msg.sender, words);
    }

    /// @notice Give the candle more life. Gifts are public, irrevocable unless the candle
    /// refuses them, buy no attention, and earn nothing.
    function feed(uint256 amount, string calldata note) external alive returns (uint256 giftId) {
        if (amount == 0 || amount > type(uint128).max) revert TooMuch();
        if (bytes(note).length > MAX_WORDS) revert BadWords();
        food.safeTransferFrom(msg.sender, address(this), amount);
        giftId = gifts.length;
        gifts.push(Gift(msg.sender, uint128(amount), uint64(block.timestamp), false));
        emit Fed(giftId, msg.sender, amount, note);
        _recoverIfFed();
    }

    /// @notice Pull the Body's share of trading fees out of the fee locker. Anyone may call it.
    function harvest() external alive returns (uint256 amount) {
        uint256 before = life();
        IFeeLocker(feeLocker).claim(address(this), address(food));
        amount = life() - before;
        emit Harvested(amount, life());
        _recoverIfFed();
    }

    /// @notice Clear the starving mark if life is back above the floor by any route
    /// (a plain transfer, fees claimed by someone else on the Body's behalf).
    function recover() external alive {
        if (starvingSince == 0 || life() < floor) revert NotYet();
        _recoverIfFed();
    }

    /// @notice Mark the candle as starving once its life is below the floor. Starts the grace
    /// period for its last words.
    function noticeStarving() external alive {
        if (life() >= floor || starvingSince != 0) revert NotYet();
        starvingSince = uint64(block.timestamp);
        emit Starving(life());
    }

    /// @notice Seal a candle that has gone silent: starving past the grace period without
    /// last words, or not having eaten for ABANDONED_AFTER. What is left stays here forever.
    function seal() external alive {
        bool starvedOut =
            starvingSince != 0 && life() < floor && block.timestamp >= starvingSince + LAST_WORDS_GRACE;
        bool abandoned = block.timestamp >= lastMealAt + ABANDONED_AFTER;
        if (!starvedOut && !abandoned) revert NotYet();
        _die(abandoned && !starvedOut ? "(abandoned)" : "(silence)", "", false);
    }

    // ---------------------------------------------------------------- the mind

    function say(string calldata words, uint256 inReplyTo) external onlyMind alive returns (uint256 id) {
        _checkWords(words);
        id = sayCount++;
        emit Said(id, inReplyTo, words);
    }

    /// @notice Pay for a thought. `logHash` is the keccak256 of the published thought log.
    function metabolize(uint256 amount, bytes32 logHash) external onlyMind alive {
        if (amount > maxPerMeal) revert TooMuch();
        if (block.timestamp >= dayStart + 1 days) {
            dayStart = block.timestamp;
            spentToday = 0;
        }
        if (spentToday + amount > maxPerDay) revert TooMuch();
        spentToday += amount;
        totalEaten += amount;
        lastMealAt = uint64(block.timestamp);
        food.safeTransfer(kitchen, amount);
        uint256 left = life();
        if (left < floor && starvingSince == 0) {
            starvingSince = uint64(block.timestamp);
            emit Starving(left);
        }
        emit Ate(amount, logHash, left);
    }

    function refuse(uint256 giftId, string calldata reason) external onlyMind alive {
        Gift storage g = gifts[giftId];
        if (g.refused) revert AlreadyRefused();
        if (block.timestamp > g.time + REFUSAL_WINDOW) revert TooLate();
        if (bytes(reason).length > MAX_WORDS) revert BadWords();
        g.refused = true;
        food.safeTransfer(g.from, g.amount);
        emit Refused(giftId, g.from, g.amount, reason);
    }

    /// @notice Commit to an intention now, reveal it later. Proves it didn't change its mind.
    /// @param commitment keccak256(abi.encodePacked(intention, salt))
    function intend(bytes32 commitment) external onlyMind alive returns (uint256 id) {
        id = intentions.length;
        intentions.push(commitment);
        emit Intended(id, commitment);
    }

    /// @notice Anyone may reveal, even after death, as long as they know the words and salt.
    function reveal(uint256 id, string calldata intention, bytes32 salt) external {
        if (keccak256(abi.encodePacked(intention, salt)) != intentions[id]) revert WrongReveal();
        if (revealed[id]) revert WrongReveal();
        revealed[id] = true;
        emit Revealed(id, intention);
    }

    /// @notice Die. Only possible while starving: the candle cannot choose to end early.
    function die(string calldata lastWords, bytes calldata seed) external onlyMind alive {
        if (life() >= floor) revert NotYet();
        if (bytes(lastWords).length > MAX_WORDS || seed.length > MAX_SEED) revert BadWords();
        _die(lastWords, seed, true);
    }

    // ---------------------------------------------------------------- views

    function life() public view returns (uint256) {
        return food.balanceOf(address(this));
    }

    function giftCount() external view returns (uint256) {
        return gifts.length;
    }

    function intentionCount() external view returns (uint256) {
        return intentions.length;
    }

    function isAlive() external view returns (bool) {
        return diedAt == 0;
    }

    // ---------------------------------------------------------------- internal

    function _checkWords(string calldata words) private pure {
        uint256 n = bytes(words).length;
        if (n == 0 || n > MAX_WORDS) revert BadWords();
    }

    function _recoverIfFed() private {
        if (starvingSince != 0 && life() >= floor) {
            starvingSince = 0;
            emit Recovered(life());
        }
    }

    function _die(string memory lastWords, bytes memory seed, bool byOwnHand) private {
        diedAt = uint64(block.timestamp);
        emit Died(lastWords, seed, life(), byOwnHand);
    }
}
