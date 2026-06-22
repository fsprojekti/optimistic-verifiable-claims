
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {OVCBase} from "./OVCBase.sol";

/**
 * @title OVCIdentity
 * @notice OVC-Identity: verifies that key K and plaintext G-code G form the
 *         on-chain ciphertext C, i.e. G XOR K == C.
 *
 * Witness:    w = (K, G, C) — key, plaintext G-code, and ciphertext triple
 * Commitment: H(K || G || C) — single hash binding the triple; no auxHash used
 * On-chain:   C stored at binding (blame-free delivery; Provider reads C and
 *             derives G = C XOR K using K received from OVC-Access)
 * Predicate:  G XOR K == on-chain C
 *
 * Witness layout passed to revealWitness:
 *   bytes[0:32]       — K (32-byte XOR key)
 *   bytes[32:32+len]  — G (plaintext G-code, len = ciphertexts[claimId].length)
 *   bytes[32+len:end] — C (ciphertext; must match on-chain copy for INCONSISTENT check)
 *
 * INCONSISTENT: keccak256(K || G || C_revealed) != commitment
 * INCORRECT:    triple matches commitment but G XOR K != on-chain C
 */
contract OVCIdentity is OVCBase {
    /// @notice Maps claimId → encrypted artifact C stored at binding time.
    mapping(uint256 => bytes) public ciphertexts;

    constructor(uint256 _disputeWindowBlocks) OVCBase(_disputeWindowBlocks) {}

    /**
     * @notice Commit an OVC-Identity claim.
     * @param provider   Address of the provider.
     * @param commitment H(K || G || C) — single hash of the witness triple,
     *                   computed off-chain before submission.
     * @param ciphertext C — encrypted G-code stored on-chain for blame-free
     *                   delivery; Provider reads it and decrypts with K.
     */
    function commitIdentityClaim(
        address provider,
        bytes32 commitment,
        bytes calldata ciphertext
    ) external returns (uint256 claimId) {
        claimId = _commitClaim(msg.sender, provider, commitment, bytes32(0), 0, bytes32(0));
        ciphertexts[claimId] = ciphertext;
    }

    /**
     * @dev Predicate: G XOR K == on-chain C.
     *      The base-class commitment check ensures the revealed triple
     *      (K, G, C_revealed) hashes to the committed H(K, G, C), so
     *      C_revealed == C_onchain by collision resistance.
     *      This function only verifies the XOR relationship.
     */
    function _verifyPredicate(uint256 claimId, Claim storage /* claim */, bytes calldata witness)
    internal
    view
    override
    returns (bool)
    {
        bytes storage c = ciphertexts[claimId];
        uint256 len = c.length;
        if (witness.length != 32 + 2 * len) return false;

        // Check G[i] XOR K[i % 32] == C[i] for all i
        for (uint256 i = 0; i < len; i++) {
            if (witness[32 + i] ^ witness[i % 32] != c[i]) return false;
        }
        return true;
    }
}
