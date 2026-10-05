// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev The one $CANDLE function the altar needs (Clanker tokens are ERC20Burnable).
interface IBurnable {
    function burnFrom(address account, uint256 value) external;
}

/// @dev The one Body function the altar calls.
interface IVoice {
    function speak(string calldata words) external returns (uint256 id);
}

/// @title CANDLE: the Altar
/// @notice To speak to the flame here, you burn a fixed amount of $CANDLE. The tokens are
/// destroyed (total supply goes down); nobody receives them. Your words reach the flame through
/// its Body like any other voice, and this contract records who really spoke and what they burned.
/// @dev No owner, no admin, no withdraw. The burn amount is fixed at deployment.
contract Altar {
    IBurnable public immutable candle;
    IVoice public immutable body;
    uint256 public immutable offering;

    uint256 public totalBurned;

    event Offered(uint256 indexed voiceId, address indexed from, uint256 burned);

    constructor(IBurnable candle_, IVoice body_, uint256 offering_) {
        candle = candle_;
        body = body_;
        offering = offering_;
    }

    /// @notice Burn `offering` $CANDLE (approve this contract first) and speak to the flame.
    function speak(string calldata words) external returns (uint256 voiceId) {
        candle.burnFrom(msg.sender, offering);
        totalBurned += offering;
        voiceId = body.speak(words);
        emit Offered(voiceId, msg.sender, offering);
    }
}
