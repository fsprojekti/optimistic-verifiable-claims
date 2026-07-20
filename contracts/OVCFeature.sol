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
 * Claim value: f_claim (net filament consumption in mm, scaled ×1e5)
 * Predicate:  f(G) == f_claim
 * Feature:    f(G) = Σ ΔE over G0/G1 motion commands under a stateful G-code
 *             machine model (M82/M83 mode, G92 re-datum, signed E, command-word
 *             context). See OVCBase._netExtrusion.
 * Note:       No off-chain delivery — G is already known to Provider from
 *             OVC-Identity (derived as C XOR K). Provider computes f(G)
 *             locally and checks against f_claim committed on-chain.
 *
 * INCONSISTENT: revealed G does not match committed H(G)
 * INCORRECT:    H(G) matches but f(G) != f_claim
 */
contract OVCFeature is OVCBase {
    constructor(uint256 _disputeWindowBlocks) OVCBase(_disputeWindowBlocks) {}

    /**
     * @dev Extracts and verifies net material consumption from G-code.
     * 'view' because we must read 'claim.claimValue' from storage.
     */
    function _verifyPredicate(uint256 /* claimId */, Claim storage claim, bytes calldata witness)
    internal
    view
    override
    returns (bool)
    {
        // 1. Net extrusion over the whole witness, scaled ×1e5
        int256 total = _netExtrusion(witness);

        // 2. A negative total is physically impossible and can never match a claim
        if (total < 0) return false;

        // 3. Exact match against the claimValue committed during the bid
        return uint256(total) == claim.claimValue;
    }
}