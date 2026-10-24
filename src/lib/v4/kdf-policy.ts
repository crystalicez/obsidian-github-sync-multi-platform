/** Remote KDF cost must remain bounded before any cryptographic work. */
export const V4_DEFAULT_PBKDF2_ITERATIONS = 600_000
export const V4_MAX_PBKDF2_ITERATIONS = 1_200_000
/** Applies only to user-chosen settings for NEW encrypted repositories. */
export const V4_MIN_NEW_PBKDF2_ITERATIONS = 600_000

export function assertV4Pbkdf2Iterations(value: unknown, minimum = 1): asserts value is number {
  if (!Number.isSafeInteger(value) || typeof value !== "number"
    || value < minimum || value > V4_MAX_PBKDF2_ITERATIONS) {
    throw new Error(`V4 PBKDF2 iterations must be an integer between ${minimum} and ${V4_MAX_PBKDF2_ITERATIONS}.`)
  }
}
