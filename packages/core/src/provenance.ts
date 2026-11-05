/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { Provenance, QualityTier } from '@cloud-carbon-footprint/common'

const COMPARED_FIELDS: (keyof Provenance)[] = [
  'sourceId',
  'zoneId',
  'granularity',
  'basis',
  'factorType',
  'isEstimated',
  'licenceId',
  'qualityTier',
  'gCO2ePerKWh',
  'modelVersion',
  'calibrationVersion',
]

const same = (a: Provenance, b: Provenance): boolean =>
  COMPARED_FIELDS.every((field) => a[field] === b[field])

/** Tier rules (design 6.4): an estimated live value is C; static stays D. */
const estimatedTier = (tier: QualityTier): QualityTier =>
  tier === 'D' ? 'D' : 'C'

const markEstimated = (provenance: Provenance): Provenance => ({
  ...provenance,
  isEstimated: true,
  qualityTier: estimatedTier(provenance.qualityTier),
})

/**
 * The provenance of a service estimate that two billing rows were
 * accumulated into. Rows of the same region and usage period normally carry
 * identical provenance, which is kept as it is. When they differ, the
 * merged row takes the fields of the lower-tier row, is marked estimated,
 * and its intensity is the energy-weighted mean of the two, which is the
 * intensity of their combined operational emissions. When only one row has
 * provenance, that one is kept, marked estimated.
 */
export const mergeProvenance = (
  a: Provenance | undefined,
  aKilowattHours: number,
  b: Provenance | undefined,
  bKilowattHours: number,
): Provenance | undefined => {
  if (!a && !b) return undefined
  if (!a || !b) return markEstimated(a ?? b)
  if (same(a, b)) return a

  const lower = a.qualityTier >= b.qualityTier ? a : b
  const totalKilowattHours = aKilowattHours + bKilowattHours
  const gCO2ePerKWh =
    totalKilowattHours > 0
      ? (a.gCO2ePerKWh * aKilowattHours + b.gCO2ePerKWh * bKilowattHours) /
        totalKilowattHours
      : (a.gCO2ePerKWh + b.gCO2ePerKWh) / 2
  return { ...markEstimated(lower), gCO2ePerKWh }
}
