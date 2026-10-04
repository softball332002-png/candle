// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Stands in for Clanker's fee locker in unit tests: holds fees per owner and pays on claim.
contract MockFeeLocker {
    mapping(address => mapping(address => uint256)) public availableFees;

    function accrue(address owner, address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        availableFees[owner][token] += amount;
    }

    function claim(address owner, address token) external {
        uint256 a = availableFees[owner][token];
        availableFees[owner][token] = 0;
        IERC20(token).transfer(owner, a);
    }
}
