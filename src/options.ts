import { InvalidArgumentError } from 'commander';

/** The most a page can hold: the API's `limit` is at most 100. */
const MAX_LIMIT = 100;

/** `--limit`: a whole number from 1 to 100. Anything else is a usage error, before any request. */
export function parseLimit(value: string): number {
  const limit = wholeNumber(value);
  if (limit === undefined || limit > MAX_LIMIT) {
    throw new InvalidArgumentError(`Use a whole number from 1 to ${MAX_LIMIT}.`);
  }
  return limit;
}

/** A count such as `--chats`: a whole number from 1. The API sets the most it accepts. */
export function parseCount(value: string): number {
  const count = wholeNumber(value);
  if (count === undefined) throw new InvalidArgumentError('Use a whole number from 1 up.');
  return count;
}

/** `--network`: one network's name, such as email or whatsapp, in lowercase as the API names them. */
export function parseNetwork(value: string): string {
  const network = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(network)) {
    throw new InvalidArgumentError('Use a network name such as email, whatsapp or telegram.');
  }
  return network;
}

/** A comma-separated list such as `--types a,b`: trimmed, without empty or repeated items. */
export function parseList(value: string): string[] {
  const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (items.length === 0) throw new InvalidArgumentError('Give one or more names, separated by commas.');
  return items;
}

/** The API's Idempotency-Key: 1 to 255 of these characters, which no shell treats specially. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,255}$/;

/** `--idempotency-key`: checked here, so a bad key never costs an upload or a request. */
export function parseIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new InvalidArgumentError('Use 1 to 255 letters, digits, ".", "_", ":" or "-".');
  }
  return value;
}

function wholeNumber(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
