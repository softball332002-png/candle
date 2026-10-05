// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @dev Test-only stand-in for $CANDLE: a burnable ERC20.
contract MockBurnable is ERC20, ERC20Burnable {
    constructor() ERC20("Mock Candle", "CANDLE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
