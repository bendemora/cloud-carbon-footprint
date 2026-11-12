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
   * kilowattHours x gCO2ePerKWh / 1e6. Two exceptions. At a factor of 0,
   * embodied emissions are in co2e but not in kilowattHours. On a row
   * merged from parts with different provenance (isEstimated is then true)
   * this is the mean of the parts' intensities weighted by their
   * operationalKilowattHours, so it is the intensity of the row's
   * electricity and co2e = operationalKilowattHours x gCO2ePerKWh / 1e6 +
   * embodiedCo2e (ADR 0024); when the parts do not carry those fields it is
   * weighted by their kilowattHours.
   */
  gCO2ePerKWh: number
  /** CCF energy model version (section 9). */
  modelVersion: string
  /** Calibration version (section 10), when calibration was applied. */
  calibrationVersion?: string
  /**
   * True when the same configuration could give a better intensity for the
   * row later (ADR 0025): the source that answered, or one tried for the
   * period before it, had not published the whole usage period yet, gave
   * preliminary values, or could not be reached. So a row can be
   * provisional although its own source covered the period, when a source
   * ranked ahead of it will cover it later. Absent on a final row, and on
   * rows estimated before the marker existed, which count as final. It does
   * not change qualityTier.
   */
  isProvisional?: boolean
}
