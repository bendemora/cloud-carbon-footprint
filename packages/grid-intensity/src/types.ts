/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Types for the grid intensity source layer. See section 6.1 of
 * docs/design/2026-11-localised-time-resolved-carbon-estimation.md.
 */

/** Cloud providers known to the source layer. */
export type CloudProvider = 'AWS' | 'GCP' | 'AZURE' | 'ALI' | 'ON_PREMISE'

/** Length of the period an intensity point or a usage row covers. */
export type Granularity = 'hour' | 'day' | 'month' | 'year'

/**
 * Accounting basis of an intensity value.
 * - location-consumption: average intensity of what a zone consumes, imports traced (flow-traced).
 * - location-production: average intensity of what a zone generates, imports not traced.
 * - marginal: intensity of the next unit of demand (for example WattTime MOER).
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

export interface LicenceDeclaration {
  id: LicenceId
  /** Text to include wherever the data is shown. */
  attribution?: string
  /** Whether a derived dataset may be shared with third parties. */
  redistributable: boolean
  retention: 'unlimited' | 'per-contract' | 'session'
  termsUrl?: string
}

export interface IntensityPoint {
  zoneId: string
  /** UTC, inclusive. */
  periodStart: Date
  /** UTC, exclusive. */
  periodEnd: Date
  granularity: Granularity
  gCO2ePerKWh: number
  basis: IntensityBasis
  factorType: EmissionFactorType
  isEstimated: boolean
  sourceId: string
  retrievedAt: Date
}

export interface ZoneCapability {
  zoneId: string
  granularities: Granularity[]
  /** Start of the lookback window the caller may fetch. Unbounded when absent. */
  earliest?: Date
  /** End of the available data. Unbounded when absent. */
  latest?: Date
  forecastHours?: number
  bases: IntensityBasis[]
  licence: LicenceDeclaration
}

export interface SourceStatus {
  reachable: boolean
  authenticated: boolean
  message?: string
}

export interface GridIntensitySource {
  /** Stable identifier, for example 'electricitymaps', 'neso' or 'static'. */
  readonly id: string
  /** Default licence for the source. Individual zones may narrow it. */
  readonly licence: LicenceDeclaration
  /**
   * False for sources whose values come from code (the static tables): the
   * resolver neither reads nor writes the store for them, so stored copies
   * cannot go stale when the tables change. Default true.
   */
  readonly persist?: boolean
  probe(): Promise<SourceStatus>
  capabilities(zoneId: string): Promise<ZoneCapability | null>
  /** The source's zone for a cloud region, or null when it has none. */
  mapRegion(provider: CloudProvider, region: string): string | null
  fetch(
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]>
}

/** Persistence of fetched intensity points. */
export interface IntensityStore {
  get(
    sourceId: string,
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]>
  put(points: IntensityPoint[]): Promise<void>
  /** Retention enforcement. Returns the number of points removed. */
  purge(sourceId: string, olderThan: Date): Promise<number>
}

/** Quality tiers, section 6.4 of the design. */
export type QualityTier = 'A' | 'B' | 'C' | 'D'

export interface Provenance {
  sourceId: string
  /** The grid zone the intensity came from, not the cloud availability zone. */
  zoneId: string
  granularity: Granularity
  basis: IntensityBasis
  factorType: EmissionFactorType
  isEstimated: boolean
  licenceId: LicenceId
  qualityTier: QualityTier
  /** CCF energy model version (section 9). */
  modelVersion: string
  /** Calibration version (section 10), when calibration was applied. */
  calibrationVersion?: string
}

export interface ResolvedIntensity {
  /** Time-weighted mean over [start, end). */
  gCO2ePerKWh: number
  points: IntensityPoint[]
  provenance: Provenance
}

/** Licence state of a source for a region, as the doctor command reports it. */
export type LicenceState =
  | 'open'
  | 'acknowledged'
  | 'needs-acknowledgement'
  | 'unavailable'

export interface SourceCapabilitySummary {
  sourceId: string
  /** The source's zone for the region, or null when it has no mapping. */
  zoneId: string | null
  licenceState: LicenceState
  /** Best tier available for each lookback window, or null when none. */
  bestTier: {
    last24Hours: QualityTier | null
    last30Days: QualityTier | null
    last12Months: QualityTier | null
  }
  error?: string
}

export interface RegionCapability {
  provider: CloudProvider
  region: string
  sources: SourceCapabilitySummary[]
}

/** Served by the doctor command and GET /api/grid-intensity/capabilities. */
export interface CapabilityReport {
  generatedAt: Date
  regions: RegionCapability[]
}

export interface IntensityResolver {
  resolve(
    provider: CloudProvider,
    region: string,
    start: Date,
    end: Date,
  ): Promise<ResolvedIntensity>
}

/**
 * Builds the doctor report. Separate from IntensityResolver because the list
 * of provider regions to report on comes from the app layer, which knows every
 * provider's static table.
 */
export interface CapabilityReporter {
  capabilities(): Promise<CapabilityReport>
}
