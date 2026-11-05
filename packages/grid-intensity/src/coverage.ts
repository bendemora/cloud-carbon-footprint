/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { Period } from './granularity'
import { IntensityPoint } from './types'

export interface WeightedMean {
  /** Mean over the covered part of the range. */
  gCO2ePerKWh: number
  /** Covered fraction of the range, 0 to 1. */
  coverage: number
}

const overlapMs = (point: IntensityPoint, start: Date, end: Date): number =>
  Math.max(
    0,
    Math.min(point.periodEnd.getTime(), end.getTime()) -
      Math.max(point.periodStart.getTime(), start.getTime()),
  )

/**
 * Time-weighted mean of the points over [start, end) (section 6.2, step 5).
 * Each point counts in proportion to its overlap with the range. Null when
 * no point overlaps. The points are assumed not to overlap each other.
 */
export const timeWeightedMean = (
  points: IntensityPoint[],
  start: Date,
  end: Date,
): WeightedMean | null => {
  const rangeMs = end.getTime() - start.getTime()
  if (rangeMs <= 0) return null

  let weightedSum = 0
  let coveredMs = 0
  for (const point of points) {
    const overlap = overlapMs(point, start, end)
    weightedSum += point.gCO2ePerKWh * overlap
    coveredMs += overlap
  }
  if (coveredMs === 0) return null
  return {
    gCO2ePerKWh: weightedSum / coveredMs,
    coverage: Math.min(1, coveredMs / rangeMs),
  }
}

/**
 * The expected periods that have no point starting at the same instant,
 * merged into contiguous ranges, so a source is asked only for what the
 * store lacks (section 6.2, step 4).
 */
export const missingPeriods = (
  expected: Period[],
  present: IntensityPoint[],
): Period[] => {
  const presentStarts = new Set(present.map((p) => p.periodStart.getTime()))
  const ranges: Period[] = []
  for (const period of expected) {
    if (presentStarts.has(period.start.getTime())) continue
    const last = ranges[ranges.length - 1]
    if (last && last.end.getTime() === period.start.getTime())
      last.end = period.end
    else ranges.push({ start: period.start, end: period.end })
  }
  return ranges
}
