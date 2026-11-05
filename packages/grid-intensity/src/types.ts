/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Types for the grid intensity source layer. See section 6.1 of
 * docs/design/2026-11-localised-time-resolved-carbon-estimation.md.
 */

import type {
  EmissionFactorType,
  Granularity,
  IntensityBasis,
  LicenceId,
  Provenance,
  QualityTier,
} from '@cloud-carbon-footprint/common'

/*
 * Granularity, IntensityBasis, EmissionFactorType, LicenceId, QualityTier and
 * Provenance live in @cloud-carbon-footprint/common, because ServiceData
 * carries Provenance. They are re-exported here so this package's API is
 * unchanged.
 */
export type {
  EmissionFactorType,
  Granularity,
  IntensityBasis,
  LicenceId,
  Provenance,
  QualityTier,
} from '@cloud-carbon-footprint/common'

/** Cloud providers known to the source layer. */
export type CloudProvider = 'AWS' | 'GCP' | 'AZURE' | 'ALI' | 'ON_PREMISE'

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
