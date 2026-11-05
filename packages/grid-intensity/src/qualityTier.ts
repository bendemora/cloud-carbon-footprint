/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { Granularity, QualityTier } from './types'

export const STATIC_SOURCE_ID = 'static'

export interface QualityTierInput {
  sourceId: string
  isEstimated: boolean
  /** Granularity of the intensity data the value was derived from. */
  intensityGranularity: Granularity
  /** Granularity of the usage row the value is applied to. */
  usageGranularity: Granularity
}

/**
 * Quality tier of an estimate row (section 6.4 of the design):
 * - A: hourly intensity for the actual hour of usage, usage at hourly granularity.
 * - B: hourly or daily intensity averaged over the actual usage period. Daily
 *   intensity applied to hourly usage also lands here (the tier drops from A).
 * - C: monthly or annual values from a live source, or values the source marks
 *   as estimated.
 * - D: the static annual constants.
 */
export const deriveQualityTier = ({
  sourceId,
  isEstimated,
  intensityGranularity,
  usageGranularity,
}: QualityTierInput): QualityTier => {
  if (sourceId === STATIC_SOURCE_ID) return 'D'
  if (
    isEstimated ||
    intensityGranularity === 'month' ||
    intensityGranularity === 'year'
  )
    return 'C'
  if (intensityGranularity === 'hour' && usageGranularity === 'hour') return 'A'
  return 'B'
}
