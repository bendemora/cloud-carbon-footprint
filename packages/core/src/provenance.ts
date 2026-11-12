/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LicenceId,
  Provenance,
  QualityTier,
} from '@cloud-carbon-footprint/common'

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

/** Whether two rows got the same intensity; the provisional marker aside. */
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

/** 0: no conditions; 1: attribution required; 2: restricted terms. */
const RESTRICTIVENESS: Record<LicenceId, number> = {
  'public-domain': 0,
  'CC-BY-4.0': 1,
  'open-attribution': 1,
  commercial: 2,
  'non-commercial': 2,
  custom: 2,
}

/**
 * The licence of a row that mixes values under two licences: the more
 * restrictive one, so a row with restricted data in it is never labelled
 * open. Two different licences of the same level become 'open-attribution'
 * (both require attribution) or 'custom' (both restrict use).
 */
const mergeLicence = (a: LicenceId, b: LicenceId): LicenceId => {
  if (a === b) return a
  if (RESTRICTIVENESS[a] !== RESTRICTIVENESS[b])
    return RESTRICTIVENESS[a] > RESTRICTIVENESS[b] ? a : b
  return RESTRICTIVENESS[a] === 2 ? 'custom' : 'open-attribution'
}

/**
 * The provenance of a service estimate that two billing rows were
 * accumulated into. Rows of the same region and usage period normally carry
 * identical provenance, which is kept as it is. When they differ, the
 * merged row takes the fields of the lower-tier row, except the licence,
 * which is the more restrictive of the two; it is marked estimated, and its
 * intensity is the mean of the two, weighted by the energy the caller gives
 * for each row. appendOrAccumulateEstimatesByDay gives each row's
 * electricity (operationalKilowattHours) when both rows carry it, so the
 * mean is the intensity of the merged row's electricity and the identity
 * of ADR 0024 holds on it. Otherwise it gives the legacy kilowattHours,
 * and the mean is the merged row's co2e (tonnes) x 1e6 divided by its
 * kilowattHours.
 * When only one row has provenance, that one is kept, marked
 * estimated. The merged row is provisional (ADR 0025) when either row is;
 * rows that differ in nothing else are not marked estimated for it.
 */
export const mergeProvenance = (
  a: Provenance | undefined,
  aKilowattHours: number,
  b: Provenance | undefined,
  bKilowattHours: number,
): Provenance | undefined => {
  if (!a && !b) return undefined
  if (!a || !b) return markEstimated(a ?? b)
  if (same(a, b)) return b.isProvisional && !a.isProvisional ? b : a

  const lower = a.qualityTier >= b.qualityTier ? a : b
  const totalKilowattHours = aKilowattHours + bKilowattHours
  const gCO2ePerKWh =
    totalKilowattHours > 0
      ? (a.gCO2ePerKWh * aKilowattHours + b.gCO2ePerKWh * bKilowattHours) /
        totalKilowattHours
      : (a.gCO2ePerKWh + b.gCO2ePerKWh) / 2
  const { isProvisional: _lowerIsProvisional, ...merged } = markEstimated(lower)
  return {
    ...merged,
    licenceId: mergeLicence(a.licenceId, b.licenceId),
    gCO2ePerKWh,
    ...((a.isProvisional || b.isProvisional) && { isProvisional: true }),
  }
}
