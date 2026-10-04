// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeLocker} from "./Body.sol";

/// @title CANDLE: the Moth Fund
/// @notice 10% of $CANDLE trading fees land here. The flame awards them, in public, to people
/// who made something for the community: art, tools, translations, memes, fixes.
/// @dev Nobody can withdraw. The only outflow is `award`, callable by the mind key, capped per
/// award and per week, each one carrying a public reason. A stolen mind key can drain at most
/// `maxPerWeek` per week, in the open.
contract MothFund {
    using SafeERC20 for IERC20;

    IERC20 public immutable food;
    address public immutable mind;
    address public immutable feeLocker;
    uint256 public immutable maxPerAward;
    uint256 public immutable maxPerWeek;

    uint256 public constant MAX_REASON = 1000;

    uint256 public weekStart;
    uint256 public awardedThisWeek;
    uint256 public totalAwarded;
    uint256 public awardCount;

    event Funded(address indexed from, uint256 amount);
    event Harvested(uint256 amount, uint256 balance);
    event Awarded(uint256 indexed id, address indexed to, uint256 amount, string reason);

    error NotMind();
    error TooMuch();
    error BadReason();

    constructor(IERC20 food_, address mind_, address feeLocker_, uint256 maxPerAward_, uint256 maxPerWeek_) {
        food = food_;
        mind = mind_;
        feeLocker = feeLocker_;
        maxPerAward = maxPerAward_;
        maxPerWeek = maxPerWeek_;
        weekStart = block.timestamp;
    }

    /// @notice Anyone may add to the fund. It buys nothing.
    function fund(uint256 amount) external {
        food.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice Pull the fund's share of trading fees out of the fee locker. Anyone may call it.
    function harvest() external returns (uint256 amount) {
        uint256 before = balance();
        IFeeLocker(feeLocker).claim(address(this), address(food));
        amount = balance() - before;
        emit Harvested(amount, balance());
    }

    function award(address to, uint256 amount, string calldata reason) external returns (uint256 id) {
        if (msg.sender != mind) revert NotMind();
        uint256 n = bytes(reason).length;
        if (n == 0 || n > MAX_REASON) revert BadReason();
        if (amount == 0 || amount > maxPerAward) revert TooMuch();
        if (block.timestamp >= weekStart + 7 days) {
            weekStart = block.timestamp;
            awardedThisWeek = 0;
        }
        if (awardedThisWeek + amount > maxPerWeek) revert TooMuch();
        awardedThisWeek += amount;
        totalAwarded += amount;
        id = awardCount++;
        food.safeTransfer(to, amount);
        emit Awarded(id, to, amount, reason);
    }

    function balance() public view returns (uint256) {
        return food.balanceOf(address(this));
    }
}
