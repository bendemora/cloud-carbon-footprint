/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  configLoader,
  getEmissionsFactors,
  Logger,
} from '@cloud-carbon-footprint/common'
import {
  addPeriod,
  addUtcMonths,
  Period,
  startOfPeriod,
  usageGranularityOf,
} from './granularity'
import {
  GridIntensityResolver,
  NoIntensityAvailableError,
  ResolverLogger,
} from './GridIntensityResolver'
import {
  appliedStaticFactor,
  StaticFactors,
  StaticFactorTable,
  StaticFactorTables,
  StaticSource,
} from './sources/StaticSource'
import { deriveQualityTier, STATIC_SOURCE_ID } from './qualityTier'
import { createIntensityStore } from './stores/createIntensityStore'
import { gramsToTonnes, tonnesToGrams } from './units'
import {
  CloudProvider,
  GridIntensitySource,
  IntensityResolver,
  IntensityStore,
  Provenance,
} from './types'

export interface EmissionsFactorsResolution {
  /** tCO2e/kWh by region: what estimateCo2 in packages/core expects. */
  factors: StaticFactors
  provenance: Provenance
}

export interface ResolveEmissionsFactorsOptions {
  /** A resolver to use instead of the default one built from configuration. */
  resolver?: IntensityResolver
  /**
   * The provider's region to Electricity Maps zone map. While
   * ELECTRICITY_MAPS_TOKEN is set, the existing v3 lookup in
   * packages/common is used first, so deployments with a token keep today's
   * behaviour until the v4 source replaces it.
   */
  legacyElectricityMapsZones?: { [region: string]: string | null }
  /** For warnings from the legacy lookup. */
  logger?: ResolverLogger
}

export const LEGACY_ELECTRICITY_MAPS_SOURCE_ID = 'electricitymaps-v3'

/*
 * The static tables the default resolver's StaticSource reads. Each call
 * registers the caller's table for its provider, so the tables stay in the
 * provider packages and this package does not depend on them.
 */
const staticTables: StaticFactorTables = {}
let defaultResolver: GridIntensityResolver | undefined
let defaultStore: (IntensityStore & { close?: () => Promise<void> }) | undefined

const SOURCE_FACTORIES: Record<string, () => GridIntensitySource> = {
  [STATIC_SOURCE_ID]: () => new StaticSource(staticTables),
}

const createDefaultResolver = (): GridIntensityResolver => {
  const ccfConfig = configLoader()
  const config = ccfConfig.GRID_INTENSITY ?? {}
  const logger = new Logger('grid-intensity')
  defaultStore = createIntensityStore(config, ccfConfig.MONGODB, logger)
  const sources: GridIntensitySource[] = []
  for (const id of config.SOURCES ?? [STATIC_SOURCE_ID]) {
    const create = SOURCE_FACTORIES[id]
    if (create) sources.push(create())
    else
      logger.warn(
        `Unknown grid intensity source '${id}' in GRID_INTENSITY_SOURCES is ignored. Available: ${Object.keys(SOURCE_FACTORIES).join(', ')}.`,
      )
  }
  return new GridIntensityResolver({
    sources,
    store: defaultStore,
    licenceAcknowledgements: config.LICENCE_ACKNOWLEDGEMENTS,
    capabilityTtlHours: config.CAPABILITY_TTL_HOURS,
    logger,
  })
}

/**
 * Discards the default resolver, so the next call rebuilds it from the
 * current configuration with fresh caches. The default resolver otherwise
 * lives for the process: one CLI run, or the life of the API server.
 */
export const resetDefaultResolver = (): void => {
  defaultResolver = undefined
  defaultStore = undefined
}

/**
 * Closes the default resolver's store (the MongoDB connection, when
 * GRID_INTENSITY_STORE is MONGODB) and discards the resolver. Call at the end
 * of a run, next to the estimates cache's own close.
 */
export const shutdownDefaultResolver = async (): Promise<void> => {
  const store = defaultStore
  resetDefaultResolver()
  await store?.close?.()
}

const factorsOf = (table: StaticFactorTable): StaticFactors =>
  typeof table.factors === 'function' ? table.factors() : table.factors

/**
 * The usage period a row stands for: from its timestamp to the start of the
 * next day, week, month, quarter or year (the CCF GroupBy values), exclusive.
 * Unknown groupings are treated as a day.
 */
export const usagePeriod = (start: Date, grouping: string): Period => {
  switch (grouping) {
    case 'week':
      return { start, end: new Date(start.getTime() + 7 * 24 * 3600 * 1000) }
    case 'month':
      return { start, end: addPeriod(start, 'month') }
    case 'quarter':
      return { start, end: addUtcMonths(start, 3) }
    case 'year':
      return { start, end: addPeriod(start, 'year') }
    default:
      return { start, end: addPeriod(start, 'day') }
  }
}

/**
 * Yesterday in UTC. For estimates with no usage period of their own
 * (recommendations, lookup tables), which used the current hour before.
 */
export const lastFullUtcDay = (now: Date = new Date()): Period => {
  const end = startOfPeriod(now, 'day')
  return { start: new Date(end.getTime() - 24 * 3600 * 1000), end }
}

let legacyLogger: ResolverLogger | undefined

/**
 * A request to Electricity Maps failed (network error, a body that is not
 * JSON, an invalid token, or a server error). It is named so that code which
 * catches errors per account or subscription (Azure) can let it through and
 * stop the run, as AWS and GCP do.
 */
export class ElectricityMapsRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ElectricityMapsRequestError'
  }
}

/** By name as well as class, in case two copies of this package are loaded. */
export const isElectricityMapsRequestError = (error: unknown): boolean =>
  error instanceof ElectricityMapsRequestError ||
  (error instanceof Error && error.name === 'ElectricityMapsRequestError')

/**
 * The v3 lookup as getEmissionsFactors does it today: one hourly sample at
 * the start of the period. A sample applied to a longer period is labelled
 * estimated. Null when it returned the static table (no zone for the region,
 * or a response without a value, which getEmissionsFactors warns about), so
 * the resolver decides.
 *
 * A failed request throws an ElectricityMapsRequestError, as getEmissionsFactors
 * threw before this package existed, so the run stops and nothing is written
 * to the estimates cache. Falling back instead would repeat the failing
 * request for every billing row, and the cache would keep the static rows for
 * good, because a cached day is never re-estimated.
 */
const legacyElectricityMapsLookup = async (
  region: string,
  periodStart: Date,
  periodEnd: Date,
  staticTable: StaticFactorTable,
  zones: { [region: string]: string | null },
  logger: ResolverLogger,
): Promise<EmissionsFactorsResolution | null> => {
  const staticFactors = factorsOf(staticTable)
  let factors: StaticFactors
  try {
    factors = await getEmissionsFactors(
      region,
      periodStart.toISOString(),
      staticFactors,
      zones,
      logger as Logger,
    )
  } catch (error) {
    throw new ElectricityMapsRequestError((error as Error).message, {
      cause: error,
    })
  }
  if (factors === staticFactors) return null
  const usageGranularity = usageGranularityOf(periodStart, periodEnd)
  const isEstimated = usageGranularity !== 'hour'
  return {
    factors,
    provenance: {
      sourceId: LEGACY_ELECTRICITY_MAPS_SOURCE_ID,
      zoneId: zones[region],
      granularity: 'hour',
      basis: 'location-consumption',
      factorType: 'lifecycle',
      isEstimated,
      licenceId: 'custom',
      qualityTier: deriveQualityTier({
        sourceId: LEGACY_ELECTRICITY_MAPS_SOURCE_ID,
        isEstimated,
        intensityGranularity: 'hour',
        usageGranularity,
      }),
      gCO2ePerKWh: tonnesToGrams(factors[region]),
      modelVersion: 'unversioned',
    },
  }
}

/**
 * Replaces getEmissionsFactors in packages/common (design section 6.1).
 * Resolves the grid intensity for a provider region over a usage period and
 * returns it in the shape estimateCo2 expects, with provenance.
 *
 * When the static source is used, or no source can serve the region, the
 * caller's own table is returned unchanged, so estimates are identical to
 * today's.
 */
export const resolveEmissionsFactors = async (
  provider: CloudProvider,
  region: string,
  periodStart: Date,
  periodEnd: Date,
  staticTable: StaticFactorTable,
  options: ResolveEmissionsFactorsOptions = {},
): Promise<EmissionsFactorsResolution> => {
  staticTables[provider] = staticTable
  const { resolver, legacyElectricityMapsZones } = options
  if (
    !resolver &&
    legacyElectricityMapsZones &&
    configLoader().ELECTRICITY_MAPS_TOKEN
  ) {
    const legacy = await legacyElectricityMapsLookup(
      region,
      periodStart,
      periodEnd,
      staticTable,
      legacyElectricityMapsZones,
      options.logger ?? (legacyLogger ??= new Logger('grid-intensity')),
    )
    if (legacy) return legacy
  }
  const activeResolver =
    resolver ?? (defaultResolver ??= createDefaultResolver())
  try {
    const resolved = await activeResolver.resolve(
      provider,
      region,
      periodStart,
      periodEnd,
    )
    if (resolved.provenance.sourceId === STATIC_SOURCE_ID)
      return {
        factors: factorsOf(staticTable),
        provenance: resolved.provenance,
      }
    const factor = gramsToTonnes(resolved.gCO2ePerKWh)
    return {
      // estimateCo2 treats a 0 factor as missing and uses Unknown instead,
      // so a zone at 0 gCO2e/kWh carries 0 there too (0, not NaN).
      factors:
        factor === 0 ? { [region]: 0, Unknown: 0 } : { [region]: factor },
      provenance: resolved.provenance,
    }
  } catch (error) {
    if (!(error instanceof NoIntensityAvailableError)) throw error
    // Static is not configured, or the table has neither the region nor an
    // Unknown entry (then estimateCo2 has no factor either: flag it).
    const zoneId = new StaticSource({ [provider]: staticTable }).mapRegion(
      provider,
      region,
    )
    const factors = factorsOf(staticTable)
    const applied = appliedStaticFactor(factors, region)
    return {
      factors,
      provenance: {
        sourceId: STATIC_SOURCE_ID,
        zoneId: zoneId ?? `${provider.toLowerCase()}:${region}`,
        granularity: 'year',
        basis: staticTable.basis ?? 'location-production',
        factorType: staticTable.factorType ?? 'direct',
        isEstimated: zoneId === null,
        licenceId: 'open-attribution',
        qualityTier: 'D',
        gCO2ePerKWh: applied === undefined ? NaN : tonnesToGrams(applied),
        modelVersion: 'unversioned',
      },
    }
  }
}
