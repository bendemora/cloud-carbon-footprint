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
  /**
   * UTC, inclusive. A point covers one whole UTC hour, day, month or year of
   * its granularity; the resolver drops points that do not.
   */
  periodStart: Date
  /** UTC, exclusive. */
  periodEnd: Date
  granularity: Granularity
  gCO2ePerKWh: number
  basis: IntensityBasis
  factorType: EmissionFactorType
  isEstimated: boolean
  /**
   * True for a value the source will replace: a forecast, or an estimate
   * that is not settled yet (ADR 0025). The resolver uses such a point, marks
   * the result provisional, and keeps the point in memory for the capability
   * TTL only: it is never written to the configured store, so a later run
   * fetches the period again.
   */
  isPreliminary?: boolean
  sourceId: string
  retrievedAt: Date
}

export interface ZoneCapability {
  zoneId: string
  granularities: Granularity[]
  /**
   * Start of the lookback window the caller may fetch. Unbounded when absent.
   * It limits fetches only: stored points from before it are still used.
   * It also decides the provisional marker (ADR 0025): a usage period that
   * lies before the first period the source can be asked for is final, and
   * a source that leaves it out keeps every period it has no data for
   * provisional.
   * The resolver fetches whole periods of the requested granularity and asks
   * only for periods that lie wholly in [earliest, latest], so a source
   * should report both on its own period boundaries (a monthly source: the
   * start of its first and the end of its last complete month).
   */
  earliest?: Date
  /**
   * End of the available data. Unbounded when absent. A day or hour of usage
   * that runs past it is served from the source's finest data up to it,
   * marked estimated; a longer period keeps its usual granularity and loses
   * the incomplete last period.
   */
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
  /** Stable identifier, for example 'neso', 'entsoe' or 'static'. */
  readonly id: string
  /** Default licence for the source. Individual zones may narrow it. */
  readonly licence: LicenceDeclaration
  /**
   * False for sources whose values come from code (the static tables): the
   * resolver neither reads nor writes the store for them, so stored copies
   * cannot go stale when the tables change, and does not apply the 0 to 1500
   * gCO2e/kWh bounds to their points. Default true.
   */
  readonly persist?: boolean
  probe(): Promise<SourceStatus>
  capabilities(zoneId: string): Promise<ZoneCapability | null>
  /** The source's zone for a cloud region, or null when it has none. */
  mapRegion(provider: CloudProvider, region: string): string | null
  /**
   * The points of the range, or fewer when the source does not have them
   * all. It throws when it cannot say: the resolver then stops asking for
   * the zone for the capability TTL. A source that read part of the range
   * before it failed throws a PartialFetchError with the points it read,
   * and the resolver keeps them. An answer in a form the source does not
   * know is a failure and not an empty list, so that a change of format
   * does not pass for missing data.
   */
  fetch(
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]>
}

/**
 * Persistence of fetched intensity points. The resolver never gives a
 * preliminary point to the configured store (ADR 0025).
 */
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

/** A cloud provider region to report capabilities for. */
export interface ProviderRegion {
  provider: CloudProvider
  region: string
}

/**
 * Licence state of a source for a region, as the doctor command reports it:
 * - open: the licence needs no acknowledgement.
 * - acknowledged: it needs one, and the operator has listed the source in
 *   GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS.
 * - needs-acknowledgement: it needs one and has none, so the source is not
 *   used.
 * - unavailable: the source has no zone, or no data, for the region.
 */
export type LicenceState =
  | 'open'
  | 'acknowledged'
  | 'needs-acknowledgement'
  | 'unavailable'

/** One value per lookback window of the capability report. Each ends now. */
export interface LookbackWindows<T> {
  last24Hours: T
  last30Days: T
  last12Months: T
}

export interface SourceCapabilitySummary {
  sourceId: string
  /** The source's zone for the region, or null when it has no mapping. */
  zoneId: string | null
  licenceState: LicenceState
  /**
   * Best tier the source can deliver for a day of usage in each lookback
   * window, or null when it can deliver none. It is what the source offers:
   * a source in the needs-acknowledgement state is not used until it is
   * acknowledged.
   */
  bestTier: LookbackWindows<QualityTier | null>
  /**
   * Share of the UTC days in each lookback window that the source can serve,
   * in whole or in part, 0 to 1. A short lookback or late data shows here.
   */
  coverage: LookbackWindows<number>
  /** Text to show wherever the source's data for the zone is shown. */
  attribution?: string
  /** A failed or unauthenticated probe, or why the zone's fetches stopped. */
  error?: string
}

export interface RegionCapability {
  provider: CloudProvider
  region: string
  /**
   * The electricity grid the region is on, from the grid zone registry
   * (design section 5.5), or null when the registry has no zone for it.
   */
  gridZoneId: string | null
  /** One entry per configured source, in GRID_INTENSITY_SOURCES order. */
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
