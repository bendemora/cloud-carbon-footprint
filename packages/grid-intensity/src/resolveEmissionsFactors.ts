/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { configLoader, Logger } from '@cloud-carbon-footprint/common'
import { GridIntensityCapabilityReporter } from './CapabilityReporter'
import { addPeriod, addUtcMonths, Period, startOfPeriod } from './granularity'
import {
  GridIntensityResolver,
  NoIntensityAvailableError,
} from './GridIntensityResolver'
import { NESO_SOURCE_ID, NesoSource } from './sources/NesoSource'
import {
  appliedStaticFactor,
  StaticFactors,
  StaticFactorTable,
  StaticFactorTables,
  StaticSource,
} from './sources/StaticSource'
import { STATIC_SOURCE_ID } from './qualityTier'
import { createIntensityStore } from './stores/createIntensityStore'
import { RecentReadsStore } from './stores/RecentReadsStore'
import { gramsToTonnes, tonnesToGrams } from './units'
import {
  CapabilityReporter,
  CloudProvider,
  GridIntensitySource,
  IntensityResolver,
  IntensityStore,
  Provenance,
  ProviderRegion,
} from './types'

export interface EmissionsFactorsResolution {
  /** tCO2e/kWh by region: what estimateCo2 in packages/core expects. */
  factors: StaticFactors
  provenance: Provenance
}

export interface ResolveEmissionsFactorsOptions {
  /** A resolver to use instead of the default one built from configuration. */
  resolver?: IntensityResolver
}

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
  [NESO_SOURCE_ID]: () => new NesoSource(),
}

const createDefaultResolver = (): GridIntensityResolver => {
  const ccfConfig = configLoader()
  const config = ccfConfig.GRID_INTENSITY ?? {}
  const logger = new Logger('grid-intensity')
  // A setting this fork has removed changes the factors a deployment gets;
  // say so wherever grid intensity is first resolved.
  for (const warning of ccfConfig.REMOVED_SETTING_WARNINGS ?? [])
    logger.warn(warning)
  // Rows of one region and period are many: their reads of the store are
  // remembered for a minute.
  defaultStore = new RecentReadsStore(
    createIntensityStore(config, ccfConfig.MONGODB, logger),
  )
  const sources: GridIntensitySource[] = []
  for (const id of config.SOURCES ?? [STATIC_SOURCE_ID]) {
    // An id is a configured string: only the table's own entries count, so
    // that 'constructor' is an unknown source and not an inherited function.
    if (Object.hasOwn(SOURCE_FACTORIES, id))
      sources.push(SOURCE_FACTORIES[id]())
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
 * Yesterday in UTC: the period for estimates with no usage period of their
 * own (recommendations, lookup tables).
 */
export const lastFullUtcDay = (now: Date = new Date()): Period => {
  const end = startOfPeriod(now, 'day')
  return { start: new Date(end.getTime() - 24 * 3600 * 1000), end }
}

/**
 * The adapter the provider packages call (design section 6.1). Resolves the
 * grid intensity for a provider region over a usage period and returns it in
 * the shape estimateCo2 expects, with provenance.
 *
 * When the static source is used, or no source can serve the region, the
 * caller's own table is returned unchanged, so those estimates are the ones
 * the static factors have always given.
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
  const activeResolver =
    options.resolver ?? (defaultResolver ??= createDefaultResolver())
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
        // A configured source could not serve the period yet (ADR 0025).
        ...(error.mayImprove && { isProvisional: true }),
      },
    }
  }
}

export interface CapabilityReporterInput {
  /** The provider regions to report on. */
  regions: ProviderRegion[]
  /** Each provider's static table, as it gives it to resolveEmissionsFactors. */
  staticTables: StaticFactorTables
}

/**
 * The capability reporter for the configured sources (the doctor command and
 * GET /api/grid-intensity/capabilities). It reports on the default resolver,
 * so in a long-running process the report shows the capability answers and
 * failures that estimates have met. Call shutdownDefaultResolver() at the
 * end of a run, as after estimates.
 */
export const createCapabilityReporter = ({
  regions,
  staticTables: tables,
}: CapabilityReporterInput): CapabilityReporter => {
  Object.assign(staticTables, tables)
  return new GridIntensityCapabilityReporter({
    resolver: (defaultResolver ??= createDefaultResolver()),
    regions,
  })
}
