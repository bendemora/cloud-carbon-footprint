/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { IntensityPoint } from './types'

/**
 * Thrown by a source's fetch() that failed part of the way through a
 * range, with the points of the part it had read. A source reads a long
 * range in several requests (NESO: 14 days each), and without this one
 * failed request would throw away the answers before it, for this run and
 * for every later one that meets the same failure. The resolver stores the
 * points and then treats the error as any other failed fetch.
 */
export class PartialFetchError extends Error {
  constructor(
    message: string,
    /** The points read before the failure. */
    readonly points: IntensityPoint[],
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'PartialFetchError'
  }
}

/**
 * The points an error carries, or none. Read by the error's name and not
 * with instanceof, so that an error from another copy of this package
 * counts as well.
 */
export const partialPointsOf = (error: unknown): IntensityPoint[] => {
  const partial = error as Partial<PartialFetchError> | null | undefined
  return partial?.name === 'PartialFetchError' && Array.isArray(partial.points)
    ? partial.points
    : []
}
