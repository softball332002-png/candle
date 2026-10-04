// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// @notice REHEARSAL ONLY. Swaps exact-in against a Uniswap v4 pool on a private fork of Base,
/// so the rehearsal can simulate traders. Never deployed to a live network.
contract ForkSwapper {
    IPoolManager public immutable pm;

    uint160 constant MIN_SQRT_PRICE = 4295128739;
    uint160 constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    struct Job {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address payer;
    }

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    /// @notice Sell `amountIn` of `tokenIn` (pulled from the caller) for the other side of the pool.
    function swap(PoolKey calldata key, address tokenIn, uint256 amountIn) external returns (uint256 amountOut) {
        bool zeroForOne = tokenIn == key.currency0;
        require(zeroForOne || tokenIn == key.currency1, "token not in pool");
        bytes memory out = pm.unlock(abi.encode(Job(key, zeroForOne, amountIn, msg.sender)));
        amountOut = abi.decode(out, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pool manager");
        Job memory j = abi.decode(data, (Job));
        int256 delta = pm.swap(
            j.key,
            SwapParams(j.zeroForOne, -int256(j.amountIn), j.zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1),
            ""
        );
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        _resolve(j.key.currency0, d0, j.payer);
        _resolve(j.key.currency1, d1, j.payer);
        uint256 out = uint256(uint128(j.zeroForOne ? d1 : d0));
        return abi.encode(out);
    }

    function _resolve(address currency, int128 d, address who) private {
        if (d < 0) {
            pm.sync(currency);
            require(IERC20(currency).transferFrom(who, address(pm), uint256(uint128(-d))), "pay failed");
            pm.settle();
        } else if (d > 0) {
            pm.take(currency, who, uint256(uint128(d)));
        }
    }
}
