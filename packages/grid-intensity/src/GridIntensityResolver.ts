/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { missingPeriods, timeWeightedMean } from './coverage'
import {
  GRANULARITIES,
  isAtLeastAsFine,
  periodsCovering,
  usageGranularityOf,
} from './granularity'
import { requiresAcknowledgement } from './licence'
import { deriveQualityTier } from './qualityTier'
import { InMemoryIntensityStore } from './stores/InMemoryIntensityStore'
import {
  CloudProvider,
  GridIntensitySource,
  Granularity,
  IntensityPoint,
  IntensityResolver,
  IntensityStore,
  ResolvedIntensity,
  ZoneCapability,
} from './types'

/** The subset of the CCF logger the resolver uses. */
export interface ResolverLogger {
  warn(message: string): void
}

export interface GridIntensityResolverOptions {
  /** Sources in priority order (GRID_INTENSITY_SOURCES). */
  sources: GridIntensitySource[]
  /** Default: an in-memory store. */
  store?: IntensityStore
  /** Source ids the operator asserts they are licensed to use. */
  licenceAcknowledgements?: string[]
  /** How long capability answers and failures are cached. Default 24. */
  capabilityTtlHours?: number
  /** CCF energy model version stamped on provenance. Default 'unversioned'. */
  modelVersion?: string
  logger?: ResolverLogger
  now?: () => Date
}

export class NoIntensityAvailableError extends Error {
  constructor(provider: CloudProvider, region: string) {
    super(`No grid intensity source can serve ${provider} region ${region}`)
    this.name = 'NoIntensityAvailableError'
  }
}

/** Data quality bounds for fetched points (design section 13). */
const MAX_G_CO2E_PER_KWH = 1500
const HOUR_MS = 60 * 60 * 1000

interface Candidate {
  source: GridIntensitySource
  zoneId: string
  capability: ZoneCapability
}

/**
 * Picks the best available source for each usage period and returns the
 * time-weighted intensity with provenance (section 6.2 of the design).
 *
 * Warnings are logged once per source and zone for an instance's lifetime,
 * and failures are negative-cached for the capability TTL. The default
 * resolver that resolveEmissionsFactors builds lives for the process: one
 * CLI run, or the life of the API server, so there a recurring failure is
 * logged once per server process.
 */
export class GridIntensityResolver implements IntensityResolver {
  private readonly sources: GridIntensitySource[]
  private readonly store: IntensityStore
  private readonly acknowledged: Set<string>
  private readonly ttlMs: number
  private readonly modelVersion: string
  private readonly logger: ResolverLogger
  private readonly now: () => Date
  private readonly capabilityCache = new Map<
    string,
    { capability: ZoneCapability | null; expiresAt: number }
  >()
  private readonly failedUntil = new Map<string, number>()
  private readonly warned = new Set<string>()

  constructor(options: GridIntensityResolverOptions) {
    this.sources = options.sources
    this.store = options.store ?? new InMemoryIntensityStore()
    this.acknowledged = new Set(options.licenceAcknowledgements ?? [])
    this.ttlMs = (options.capabilityTtlHours ?? 24) * HOUR_MS
    this.modelVersion = options.modelVersion ?? 'unversioned'
    this.logger = options.logger ?? { warn: () => undefined }
    this.now = options.now ?? (() => new Date())
  }

  async resolve(
    provider: CloudProvider,
    region: string,
    start: Date,
    end: Date,
  ): Promise<ResolvedIntensity> {
    if (start >= end)
      throw new RangeError(
        `Empty usage period ${start.toISOString()} to ${end.toISOString()}`,
      )
    const usageGranularity = usageGranularityOf(start, end)

    // Step 2: sources fine enough for the usage period first, in order;
    // coarser ones only when none of those can serve it, finest first
    // (a live monthly value beats the static annual one), ties in order.
    const coarser: Candidate[] = []
    for (const source of this.sources) {
      const candidate = await this.candidate(
        source,
        provider,
        region,
        start,
        end,
      )
      if (!candidate) continue
      const finest = finestOf(candidate.capability.granularities)
      if (!isAtLeastAsFine(finest, usageGranularity)) {
        coarser.push(candidate)
        continue
      }
      const resolved = await this.resolveFrom(
        candidate,
        start,
        end,
        usageGranularity,
      )
      if (resolved) return resolved
    }
    const rank = (c: Candidate) =>
      GRANULARITIES.indexOf(finestOf(c.capability.granularities))
    coarser.sort((a, b) => rank(a) - rank(b))
    for (const candidate of coarser) {
      const resolved = await this.resolveFrom(
        candidate,
        start,
        end,
        usageGranularity,
      )
      if (resolved) return resolved
    }
    throw new NoIntensityAvailableError(provider, region)
  }

  /** Steps 1 to 3: mapping, capability and licence checks. */
  private async candidate(
    source: GridIntensitySource,
    provider: CloudProvider,
    region: string,
    start: Date,
    end: Date,
  ): Promise<Candidate | null> {
    const zoneId = source.mapRegion(provider, region)
    if (!zoneId) return null
    const zoneRef = `${source.id}|${zoneId}`
    if ((this.failedUntil.get(zoneRef) ?? 0) > this.now().getTime()) return null

    const capability = await this.capability(source, zoneId)
    if (!capability || !capability.granularities.length) return null
    if (capability.earliest && start < capability.earliest) return null
    if (capability.latest && end > capability.latest) return null
    if (
      requiresAcknowledgement(capability.licence) &&
      !this.acknowledged.has(source.id)
    ) {
      this.warnOnce(
        `licence|${source.id}`,
        `Grid intensity source ${source.id} has a ${capability.licence.id} licence and is not used. Add ${source.id} to GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS if you hold the rights to use it.`,
      )
      return null
    }
    return { source, zoneId, capability }
  }

  private async capability(
    source: GridIntensitySource,
    zoneId: string,
  ): Promise<ZoneCapability | null> {
    const zoneRef = `${source.id}|${zoneId}`
    const nowMs = this.now().getTime()
    const cached = this.capabilityCache.get(zoneRef)
    if (cached && cached.expiresAt > nowMs) return cached.capability
    try {
      const capability = await source.capabilities(zoneId)
      this.capabilityCache.set(zoneRef, {
        capability,
        expiresAt: nowMs + this.ttlMs,
      })
      return capability
    } catch (error) {
      this.fail(source, zoneId, 'capability probe', error)
      return null
    }
  }

  /** Steps 4 to 6: store, fetch what is missing, time-weight, provenance. */
  private async resolveFrom(
    { source, zoneId, capability }: Candidate,
    start: Date,
    end: Date,
    usageGranularity: Granularity,
  ): Promise<ResolvedIntensity | null> {
    const granularity = requestGranularity(
      capability.granularities,
      usageGranularity,
    )
    const persist = source.persist !== false
    const stored = persist
      ? await this.storedPoints(source.id, zoneId, start, end, granularity)
      : []
    const fetched: IntensityPoint[] = []
    for (const range of missingPeriods(
      periodsCovering(start, end, granularity),
      stored,
    )) {
      try {
        const points = await source.fetch(
          zoneId,
          range.start,
          range.end,
          granularity,
        )
        // The bounds are a check on fetched data before it is stored (design
        // section 13). Values from code are not fetched or stored, and CCF's
        // GCP multi-region factors (sums across data centres) exceed them.
        fetched.push(
          ...(persist ? this.validPoints(source.id, zoneId, points) : points),
        )
      } catch (error) {
        this.fail(source, zoneId, 'fetch', error)
        break
      }
    }
    if (persist && fetched.length && capability.licence.retention !== 'session')
      await this.storePoints(fetched)

    const byStart = new Map<number, IntensityPoint>()
    for (const point of [...stored, ...fetched])
      byStart.set(point.periodStart.getTime(), point)
    const points = [...byStart.values()]
      .filter((p) => p.periodStart < end && p.periodEnd > start)
      .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime())

    const mean = timeWeightedMean(points, start, end)
    if (!mean) return null
    const isEstimated = mean.coverage < 1 || points.some((p) => p.isEstimated)
    return {
      gCO2ePerKWh: mean.gCO2ePerKWh,
      points,
      provenance: {
        sourceId: source.id,
        zoneId,
        granularity,
        basis: points[0].basis,
        factorType: points[0].factorType,
        isEstimated,
        licenceId: capability.licence.id,
        qualityTier: deriveQualityTier({
          sourceId: source.id,
          isEstimated,
          intensityGranularity: granularity,
          usageGranularity,
        }),
        gCO2ePerKWh: mean.gCO2ePerKWh,
        modelVersion: this.modelVersion,
      },
    }
  }

  private validPoints(
    sourceId: string,
    zoneId: string,
    points: IntensityPoint[],
  ): IntensityPoint[] {
    const valid = points.filter(
      (p) =>
        Number.isFinite(p.gCO2ePerKWh) &&
        p.gCO2ePerKWh >= 0 &&
        p.gCO2ePerKWh <= MAX_G_CO2E_PER_KWH,
    )
    const dropped = points.length - valid.length
    if (dropped > 0)
      this.warnOnce(
        `quality|${sourceId}|${zoneId}`,
        `Dropped ${dropped} point${dropped === 1 ? '' : 's'} from grid intensity source ${sourceId} for zone ${zoneId} outside 0 to ${MAX_G_CO2E_PER_KWH} gCO2e/kWh.`,
      )
    return valid
  }

  private async storedPoints(
    sourceId: string,
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]> {
    try {
      return await this.store.get(sourceId, zoneId, start, end, granularity)
    } catch (error) {
      this.warnOnce(
        'store',
        `Grid intensity store unavailable: ${messageOf(error)}`,
      )
      return []
    }
  }

  private async storePoints(points: IntensityPoint[]): Promise<void> {
    try {
      await this.store.put(points)
    } catch (error) {
      this.warnOnce(
        'store',
        `Grid intensity store unavailable: ${messageOf(error)}`,
      )
    }
  }

  private fail(
    source: GridIntensitySource,
    zoneId: string,
    operation: string,
    error: unknown,
  ): void {
    const zoneRef = `${source.id}|${zoneId}`
    this.failedUntil.set(zoneRef, this.now().getTime() + this.ttlMs)
    this.warnOnce(
      `failure|${zoneRef}`,
      `Grid intensity source ${source.id} ${operation} failed for zone ${zoneId}: ${messageOf(error)}. Skipping it for ${this.ttlMs / HOUR_MS} hours.`,
    )
  }

  private warnOnce(id: string, message: string): void {
    if (this.warned.has(id)) return
    this.warned.add(id)
    this.logger.warn(message)
  }
}

/** Callers give a non-empty list; candidate() rejects empty capabilities. */
const finestOf = (granularities: Granularity[]): Granularity =>
  GRANULARITIES.find((g) => granularities.includes(g)) as Granularity

/**
 * Hourly data for hourly usage, daily data for anything longer (5.2: daily
 * windows for daily usage). When the source has neither, the closest finer
 * granularity it has, otherwise its finest.
 */
const requestGranularity = (
  available: Granularity[],
  usageGranularity: Granularity,
): Granularity => {
  const target: Granularity = usageGranularity === 'hour' ? 'hour' : 'day'
  const fineEnough = GRANULARITIES.filter(
    (g) => available.includes(g) && isAtLeastAsFine(g, target),
  )
  return fineEnough.length
    ? fineEnough[fineEnough.length - 1]
    : finestOf(available)
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
