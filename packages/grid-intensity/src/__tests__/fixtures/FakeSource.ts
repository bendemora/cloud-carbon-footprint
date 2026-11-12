/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { periodsCovering } from '../../granularity'
import {
  CloudProvider,
  GridIntensitySource,
  Granularity,
  IntensityPoint,
  LicenceDeclaration,
  SourceStatus,
  ZoneCapability,
} from '../../types'

export interface FakeSourceOptions {
  id?: string
  /** region to zone; regions not listed have no mapping */
  zones?: Record<string, string>
  granularities?: Granularity[]
  licence?: Partial<LicenceDeclaration>
  earliest?: Date
  latest?: Date
  /** gCO2e/kWh for a period; default 100 */
  value?: (periodStart: Date, granularity: Granularity) => number
  isEstimated?: boolean
  failCapabilities?: boolean
  failFetch?: boolean
  /** answer that the source has no capability for the zone */
  unavailable?: boolean
  /** the probe answer; default reachable and authenticated */
  status?: SourceStatus
  failProbe?: boolean
  /** omit the points for these period starts (ISO strings) */
  omit?: string[]
  /** whether the point for a period is preliminary; default none is */
  preliminary?: (periodStart: Date) => boolean
}

export interface FetchCall {
  zoneId: string
  start: string
  end: string
  granularity: Granularity
}

/** A configurable GridIntensitySource for resolver tests. */
export class FakeSource implements GridIntensitySource {
  readonly id: string
  readonly licence: LicenceDeclaration
  readonly fetchCalls: FetchCall[] = []
  capabilityCalls = 0
  probeCalls = 0
  failCapabilities: boolean
  failFetch: boolean
  /** Tests change these to let a later fetch return more, or settled, data. */
  omit: string[]
  preliminary: (periodStart: Date) => boolean

  constructor(private readonly options: FakeSourceOptions = {}) {
    this.id = options.id ?? 'fake'
    this.licence = {
      id: 'CC-BY-4.0',
      attribution: 'Fake source',
      redistributable: true,
      retention: 'unlimited',
      ...options.licence,
    }
    this.failCapabilities = options.failCapabilities ?? false
    this.failFetch = options.failFetch ?? false
    this.omit = options.omit ?? []
    this.preliminary = options.preliminary ?? (() => false)
  }

  async probe(): Promise<SourceStatus> {
    this.probeCalls++
    if (this.options.failProbe) throw new Error('getaddrinfo ENOTFOUND')
    return this.options.status ?? { reachable: true, authenticated: true }
  }

  mapRegion(_provider: CloudProvider, region: string): string | null {
    const zones = this.options.zones ?? { 'eu-west-2': 'GB' }
    return zones[region] ?? null
  }

  async capabilities(zoneId: string): Promise<ZoneCapability | null> {
    this.capabilityCalls++
    if (this.failCapabilities) throw new Error('capability probe failed')
    if (this.options.unavailable) return null
    return {
      zoneId,
      granularities: this.options.granularities ?? ['hour', 'day'],
      earliest: this.options.earliest,
      latest: this.options.latest,
      bases: ['location-consumption'],
      licence: this.licence,
    }
  }

  async fetch(
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]> {
    this.fetchCalls.push({
      zoneId,
      start: start.toISOString(),
      end: end.toISOString(),
      granularity,
    })
    if (this.failFetch) throw new Error('401 Unauthorized')
    const value = this.options.value ?? (() => 100)
    const omit = new Set(this.omit)
    return periodsCovering(start, end, granularity)
      .filter((p) => !omit.has(p.start.toISOString()))
      .map((p) => ({
        zoneId,
        periodStart: p.start,
        periodEnd: p.end,
        granularity,
        gCO2ePerKWh: value(p.start, granularity),
        basis: 'location-consumption' as const,
        factorType: 'lifecycle' as const,
        isEstimated: this.options.isEstimated ?? false,
        ...(this.preliminary(p.start) && { isPreliminary: true }),
        sourceId: this.id,
        retrievedAt: new Date('2026-11-05T12:00:00.000Z'),
      }))
  }
}
