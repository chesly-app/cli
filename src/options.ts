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

function wholeNumber(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
