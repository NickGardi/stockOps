/** Pure formatter for PO display number - safe for client and server */

export function formatPoDisplayNumber(poNumber: number): string {
  return `PO-${String(poNumber).padStart(3, "0")}`;
}

export function formatTransferDisplayNumber(transferNumber: number): string {
  return `TR-${String(transferNumber).padStart(3, "0")}`;
}
