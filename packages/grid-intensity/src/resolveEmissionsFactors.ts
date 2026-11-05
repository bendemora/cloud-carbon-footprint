/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { configLoader, Logger } from '@cloud-carbon-footprint/common'
import {
  GridIntensityResolver,
  NoIntensityAvailableError,
} from './GridIntensityResolver'
import {
  StaticFactors,
  StaticFactorTable,
  StaticFactorTables,
  StaticSource,
} from './sources/StaticSource'
import { STATIC_SOURCE_ID } from './qualityTier'
import { gramsToTonnes } from './units'
import {
  CloudProvider,
  GridIntensitySource,
  IntensityResolver,
  Provenance,
} from './types'

export interface EmissionsFactorsResolution {
  /** tCO2e/kWh by region: what estimateCo2 in packages/core expects. */
  factors: StaticFactors
  provenance: Provenance
}

/*
 * The static tables the default resolver's StaticSource reads. Each call
 * registers the caller's table for its provider, so the tables stay in the
 * provider packages and this package does not depend on them.
 */
const staticTables: StaticFactorTables = {}
let defaultResolver: GridIntensityResolver | undefined

const SOURCE_FACTORIES: Record<string, () => GridIntensitySource> = {
  [STATIC_SOURCE_ID]: () => new StaticSource(staticTables),
}

const createDefaultResolver = (): GridIntensityResolver => {
  const config = configLoader().GRID_INTENSITY ?? {}
  const logger = new Logger('grid-intensity')
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
    licenceAcknowledgements: config.LICENCE_ACKNOWLEDGEMENTS,
    capabilityTtlHours: config.CAPABILITY_TTL_HOURS,
    logger,
  })
}

/**
 * Discards the default resolver, so the next call rebuilds it from the
 * current configuration with fresh caches. Call at the start of an
 * estimation run.
 */
export const resetDefaultResolver = (): void => {
  defaultResolver = undefined
}

const factorsOf = (table: StaticFactorTable): StaticFactors =>
  typeof table.factors === 'function' ? table.factors() : table.factors

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
  resolver?: IntensityResolver,
): Promise<EmissionsFactorsResolution> => {
  staticTables[provider] = staticTable
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
    return {
      factors: { [region]: gramsToTonnes(resolved.gCO2ePerKWh) },
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
    return {
      factors: factorsOf(staticTable),
      provenance: {
        sourceId: STATIC_SOURCE_ID,
        zoneId: zoneId ?? `${provider.toLowerCase()}:${region}`,
        granularity: 'year',
        basis: staticTable.basis ?? 'location-production',
        factorType: staticTable.factorType ?? 'direct',
        isEstimated: zoneId === null,
        licenceId: 'open-attribution',
        qualityTier: 'D',
        modelVersion: 'unversioned',
      },
    }
  }
}
