/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Where the grid intensity behind an estimate came from (design section 6.1,
 * docs/design/2026-11-localised-time-resolved-carbon-estimation.md). Defined
 * here rather than in @cloud-carbon-footprint/grid-intensity because
 * ServiceData carries it and grid-intensity depends on this package.
 */

/** Length of the period an intensity value or a usage row covers. */
export type Granularity = 'hour' | 'day' | 'month' | 'year'

/**
 * Accounting basis of an intensity value.
 * - location-consumption: average intensity of what a zone consumes, imports traced (flow-traced).
 * - location-production: average intensity of what a zone generates, imports not traced.
 * - marginal: intensity of the next unit of demand.
 */
export type IntensityBasis =
  | 'location-consumption'
  | 'location-production'
  | 'marginal'

/** Whether upstream (lifecycle) emissions are included, or combustion only (direct). */
export type EmissionFactorType = 'lifecycle' | 'direct'

export type LicenceId =
  | 'public-domain'
  | 'CC-BY-4.0'
  | 'open-attribution'
  | 'non-commercial'
  | 'commercial'
  | 'custom'

/** Quality tiers, section 6.4 of the design. A is best, D is the static annual factors. */
export type QualityTier = 'A' | 'B' | 'C' | 'D'

export interface Provenance {
  sourceId: string
  /** The source's zone that the intensity came from, not the cloud availability zone. */
  zoneId: string
  granularity: Granularity
  basis: IntensityBasis
  factorType: EmissionFactorType
  isEstimated: boolean
  licenceId: LicenceId
  qualityTier: QualityTier
  /**
   * The grid intensity applied to the row, gCO2e/kWh. The row's
   * kilowattHours includes embodied emissions converted to energy at this
   * same factor, so for a row with a co2e value, co2e (tonnes) is
   * kilowattHours x gCO2ePerKWh / 1e6; it is not an intensity of operational
   * energy alone. The exception is a factor of 0: embodied emissions are
   * then in co2e but not in kilowattHours.
   */
  gCO2ePerKWh: number
  /** CCF energy model version (section 9). */
  modelVersion: string
  /** Calibration version (section 10), when calibration was applied. */
  calibrationVersion?: string
}
