/** Compare identifiers as strings: portal IDs exceed JavaScript's safe integer range. */
export function requestContainsBatch(url: string, body: string | null, batchId: string): boolean {
  const query = new URL(url).searchParams;
  if (query.get('taskId') === batchId) return true;
  if (!body) return false;
  if (new URLSearchParams(body).get('taskId') === batchId) return true;
  const field = body.match(/"taskId"\s*:\s*"?(\d+)"?(?=\s*[,}])/);
  return field?.[1] === batchId;
}

export function hasExactBatch(cells: string[], batchId: string): boolean {
  return cells.some((cell) => cell.trim() === batchId);
}
