// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCBase.sol";

/**
 * @title OVCFeature
 * @notice OVC-Feature: verifies that the total filament extrusion
 *         extracted from G-code G matches the claimed value f_claim.
 *
 * Witness:    w = G — plaintext G-code
 * Commitment: H(G)
 * Claim value: f_claim (filament length in mm × 1000, e.g. 6000 = 6.0 mm)
 * Predicate:  E_final(G) == f_claim
 * Feature:    Total filament extrusion under absolute extrusion mode (M82) is the
 *             FINAL cumulative E-value in G; decimal values are scaled by 1000.
 * Note:       No off-chain delivery — G is already known to Provider from
 *             OVC-Identity (derived as C XOR K). Provider computes E_final
 *             locally and checks against f_claim committed on-chain.
 *
 * INCONSISTENT: revealed G does not match committed H(G)
 * INCORRECT:    H(G) matches but E_final(G) != f_claim
 */
contract OVCFeature is OVCBase {
    constructor(uint256 _disputeWindowBlocks) OVCBase(_disputeWindowBlocks) {}

    /**
     * @dev Extracts and verifies the total material consumption (E-sum) from G-code.
     * Changed to 'view' because we must read 'claim.claimValue' from storage.
     */
    function _verifyPredicate(uint256 /* claimId */, Claim storage claim, bytes calldata witness)
    internal
    view
    override
    returns (bool)
    {
        // 1. Final cumulative E-value = total filament extrusion (absolute mode), scaled ×1000
        uint256 totalExtrusion = _extractLastE(witness);

        // 2. Exact match against the claimValue committed during the bid (e.g. 6.0mm = 6000)
        return totalExtrusion == claim.claimValue;
    }
}