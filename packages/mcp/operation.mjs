const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export function requiredIdempotencyKey(input) {
  const value = input?.idempotency_key;
  if (typeof value !== "string" || !idempotencyKeyPattern.test(value)) {
    throw new Error(
      "idempotency_key is required and must be 1–128 safe characters; reuse it when retrying the same operation",
    );
  }
  return value;
}

export function boundedInteger(value, fallback, minimum, maximum, name) {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return selected;
}

export class OperationRecovery extends Error {
  constructor(cause, idempotencyKey) {
    super("durable operation needs recovery");
    this.name = "OperationRecovery";
    this.cause = cause;
    this.idempotencyKey = idempotencyKey;
  }
}

export async function withOperationRecovery(operation, idempotencyKey) {
  try {
    return await operation();
  } catch (cause) {
    if (!ambiguousOperationFailure(cause)) throw cause;
    throw new OperationRecovery(cause, idempotencyKey);
  }
}

function ambiguousOperationFailure(cause) {
  if (cause?._tag === "RequestError" || cause?._tag === "ForkPending") {
    return true;
  }
  if (cause?._tag !== "ResponseError") return false;
  return (
    cause.status === 408 ||
    cause.status === 425 ||
    cause.status === 429 ||
    cause.status >= 500
  );
}
