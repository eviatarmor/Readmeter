let callId = 0;
let listenerId = 0;
let transactionId = 0;
let salt = randomSalt();

function randomSalt(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return n;
}

/** New process or tab. Decimal u64 so it survives a JS number round-trip. */
export function newSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return n.toString(10);
}

export function resetIds(): void {
  callId = 0;
  listenerId = 0;
  transactionId = 0;
  salt = randomSalt();
}

/** Per-session salt for payload digests. Stays in this process. */
export function payloadSalt(): bigint {
  return salt;
}

export function nextCallId(): number {
  callId += 1;
  return callId;
}

export function nextListenerId(): number {
  listenerId += 1;
  return listenerId;
}

/** One id per `runTransaction` call. A counter, not a hash. */
export function nextTransactionId(): number {
  transactionId += 1;
  return transactionId;
}
