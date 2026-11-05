/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { periodsCovering } from '../granularity'
import { STATIC_SOURCE_ID } from '../qualityTier'
import { tonnesToGrams } from '../units'
import {
  CloudProvider,
  EmissionFactorType,
  GridIntensitySource,
  Granularity,
  IntensityBasis,
  IntensityPoint,
  LicenceDeclaration,
  SourceStatus,
  ZoneCapability,
} from '../types'

/** tCO2e/kWh by provider region, the shape of the CCF constants tables. */
export type StaticFactors = { [region: string]: number }

export interface StaticFactorTable {
  /**
   * The provider's factors, or a function returning them. A function is read
   * on every call, for tables that depend on configuration (GCP's
   * carbon-free-energy option).
   */
  factors: StaticFactors | (() => StaticFactors)
  /** Default 'location-production'. */
  basis?: IntensityBasis
  /** Default 'direct'. */
  factorType?: EmissionFactorType
}

export type StaticFactorTables = Partial<
  Record<CloudProvider, StaticFactorTable>
>

const UNKNOWN_REGION = 'Unknown'
const GRANULARITY: Granularity = 'year'

/**
 * The CCF static annual grid emissions factors as a grid intensity source.
 * Always available, quality tier D. The tables stay in the provider packages
 * and are given to the constructor, so this package does not depend on them.
 *
 * Zones are named '<provider>:<region>' in lower-case provider form, for
 * example 'aws:eu-west-2'. A region missing from a table maps to the table's
 * 'Unknown' entry, which matches what estimateCo2 in packages/core does today.
 */
export class StaticSource implements GridIntensitySource {
  readonly id = STATIC_SOURCE_ID
  readonly persist = false
  readonly licence: LicenceDeclaration = {
    id: 'open-attribution',
    attribution:
      'Cloud Carbon Footprint static grid emissions factors (Apache-2.0); sources listed in the CCF methodology, Appendix V',
    redistributable: true,
    retention: 'unlimited',
    termsUrl:
      'https://www.cloudcarbonfootprint.org/docs/methodology#appendix-v-grid-emissions-factors',
  }

  constructor(
    private readonly tables: StaticFactorTables,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async probe(): Promise<SourceStatus> {
    return { reachable: true, authenticated: true }
  }

  mapRegion(provider: CloudProvider, region: string): string | null {
    const factors = this.factorsFor(provider)
    if (!factors) return null
    if (Object.hasOwn(factors, region)) return zoneId(provider, region)
    if (Object.hasOwn(factors, UNKNOWN_REGION))
      return zoneId(provider, UNKNOWN_REGION)
    return null
  }

  async capabilities(zone: string): Promise<ZoneCapability | null> {
    const entry = this.lookup(zone)
    if (!entry) return null
    return {
      zoneId: zone,
      granularities: [GRANULARITY],
      bases: [entry.basis],
      licence: this.licence,
    }
  }

  async fetch(
    zone: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]> {
    if (granularity !== GRANULARITY)
      throw new Error(
        `Static source only provides ${GRANULARITY} granularity, not ${granularity}`,
      )
    const entry = this.lookup(zone)
    if (!entry) throw new Error(`Static source has no factor for zone ${zone}`)

    const gCO2ePerKWh = tonnesToGrams(entry.tonnesPerKWh)
    const retrievedAt = this.now()
    return periodsCovering(start, end, GRANULARITY).map((period) => ({
      zoneId: zone,
      periodStart: period.start,
      periodEnd: period.end,
      granularity: GRANULARITY,
      gCO2ePerKWh,
      basis: entry.basis,
      factorType: entry.factorType,
      isEstimated: false,
      sourceId: this.id,
      retrievedAt,
    }))
  }

  private factorsFor(provider: CloudProvider): StaticFactors | undefined {
    const table = this.tables[provider]
    if (!table) return undefined
    return typeof table.factors === 'function' ? table.factors() : table.factors
  }

  private lookup(zone: string):
    | {
        tonnesPerKWh: number
        basis: IntensityBasis
        factorType: EmissionFactorType
      }
    | undefined {
    const separator = zone.indexOf(':')
    if (separator < 0) return undefined
    const provider = PROVIDERS_BY_ZONE_PREFIX[zone.slice(0, separator)]
    if (!provider) return undefined
    const factors = this.factorsFor(provider)
    const region = zone.slice(separator + 1)
    if (!factors || !Object.hasOwn(factors, region)) return undefined
    const table = this.tables[provider]
    return {
      tonnesPerKWh: factors[region],
      basis: table.basis ?? 'location-production',
      factorType: table.factorType ?? 'direct',
    }
  }
}

const PROVIDERS: readonly CloudProvider[] = [
  'AWS',
  'GCP',
  'AZURE',
  'ALI',
  'ON_PREMISE',
]

const PROVIDERS_BY_ZONE_PREFIX: Record<string, CloudProvider> =
  Object.fromEntries(PROVIDERS.map((p) => [p.toLowerCase(), p]))

const zoneId = (provider: CloudProvider, region: string): string =>
  `${provider.toLowerCase()}:${region}`
