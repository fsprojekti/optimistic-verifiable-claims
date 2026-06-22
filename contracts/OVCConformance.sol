// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCBase.sol";

/**
 * @title OVCConformance
 * @notice OVC-Conformance: verifies that plaintext G-code G contains at least
 *         one G0 or G1 motion command.
 *
 * Witness:    w = G — plaintext G-code
 * Commitment: H(G)
 * Predicate:  G contains at least one G0 or G1 motion command
 * Note:       No off-chain delivery — G is already known to Provider from
 *             OVC-Identity (derived as C XOR K). Provider checks conformance
 *             locally; commits H(G) to bind the specific G being claimed.
 *
 * INCONSISTENT: revealed G does not match committed H(G)
 * INCORRECT:    H(G) matches but G has no G0 or G1 commands
 */
contract OVCConformance is OVCBase {
    constructor(uint256 _disputeWindowBlocks) OVCBase(_disputeWindowBlocks) {}

    /**
     * @dev Raw scanning logic.
     * We use 'view' to match OVCBase, but the logic inside is 'pure'.
     */
    function _verifyPredicate(uint256 /* claimId */, Claim storage /* claim */, bytes calldata witness)
    internal
    view
    override
    returns (bool)
    {
        uint256 len = witness.length;
        if (len < 2) return false;

        bool foundGcode = false;

        // RAW SCANNING LOOP
        for (uint256 i = 0; i < len - 1; i++) {
            // ASCII 71 = 'G', 48 = '0', 49 = '1'
            if (witness[i] == 0x47) {
                bytes1 next = witness[i + 1];
                if (next == 0x30 || next == 0x31) {
                    foundGcode = true;
                    // We scan the whole file to measure the gas accurately
                }
            }
        }
        return foundGcode;
    }
}