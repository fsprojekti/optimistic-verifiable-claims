// Read the ID assigned to this transaction, rather than a potentially stale
// or subsequently incremented latest-state counter from another RPC backend.
function receiptIdentifier(receipt, contract, eventName, idField, actorField, actor) {
  const matches = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.target.toLowerCase()) continue;
    let decoded;
    try { decoded = contract.interface.parseLog(log); } catch { continue; }
    if (decoded?.name === eventName) matches.push(decoded);
  }
  if (receipt.status !== 1 || matches.length !== 1 ||
      matches[0].args[actorField].toLowerCase() !== actor.toLowerCase() ||
      matches[0].args[idField] <= 0n) {
    throw new Error(`RECEIPT_IDENTITY: invalid ${eventName} receipt`);
  }
  return matches[0].args[idField];
}

module.exports = { receiptIdentifier };
