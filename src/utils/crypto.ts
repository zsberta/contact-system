/**
 * Cryptographically secure random value generator
 * Uses the Web Crypto API (crypto.getRandomValues)
 */

/**
 * Get a single random float between 0 (inclusive) and 1 (exclusive)
 * Uses Uint32Array to avoid Float64Array type mismatch error
 */
export const getSecureRandom = (): number => {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] / 0xFFFFFFFF;
};

/**
 * Get an array of random floats between 0 (inclusive) and 1 (exclusive)
 */
export const getSecureRandomValues = (count: number): number[] => {
  const array = new Uint32Array(count);
  crypto.getRandomValues(array);
  return Array.from(array).map((v) => v / 0xFFFFFFFF);
};

/**
 * Get a random integer between 0 (inclusive) and max (exclusive)
 */
export const getSecureRandomInt = (max: number): number => {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] % max;
};

/**
 * Generate a secure temporary ID string
 * Format: temp-{timestamp}-{randomHex}
 */
export const generateSecureTempId = (): string => {
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  const hex = Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `temp-${Date.now()}-${hex}`;
};
