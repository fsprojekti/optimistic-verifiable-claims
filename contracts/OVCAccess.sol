// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCBase.sol";

contract OVCAccess is OVCBase {
    constructor(uint256 _disputeWindowBlocks) OVCBase(_disputeWindowBlocks) {}

    function _verifyPredicate(uint256 /* claimId */, Claim storage claim, bytes calldata witness)
        internal
        view
        override
        returns (bool)
    {
        return keccak256(abi.encodePacked(witness, claim.providerKeyHash)) == claim.auxHash;
    }
}
