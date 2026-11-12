/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { missingPeriods, timeWeightedMean } from './coverage'
import {
  addPeriod,
  coarsestWithin,
  GRANULARITIES,
  isAtLeastAsFine,
  Period,
  periodsCovering,
  startOfPeriod,
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
  QualityTier,
  ResolvedIntensity,
  SourceStatus,
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
  /**
   * How long capability answers, failures and warnings are kept, and the
   * longest that session-retention points and preliminary points are held
   * (they are released together, by the first resolve call after it).
   * Default 24.
   */
  capabilityTtlHours?: number
  /** CCF energy model version stamped on provenance. Default 'unversioned'. */
  modelVersion?: string
  logger?: ResolverLogger
  now?: () => Date
}

/** What the resolver knows about one source for a provider region. */
export interface SourceView {
  source: GridIntensitySource
  /** The source's zone for the region, or null when it has no mapping. */
  zoneId: string | null
  /**
   * The zone's capability: the answer kept for the TTL, or the last one
   * after a failed probe. Null when the source has none for the zone, or has
   * not answered yet.
   */
  capability: ZoneCapability | null
  /** Whether the operator has acknowledged the source's licence. */
  acknowledged: boolean
  status: SourceStatus
  /** Why the zone's fetches are stopped, while they are. */
  failure?: string
}

export class NoIntensityAvailableError extends Error {
  constructor(
    provider: CloudProvider,
    region: string,
    /**
     * Whether a configured source could serve the period on a later run, so
     * whatever the caller falls back to is provisional (ADR 0025).
     */
    readonly mayImprove: boolean = false,
  ) {
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

interface Resolution {
  resolved: ResolvedIntensity
  /** Covered fraction of the usage period, 0 to 1. */
  coverage: number
}

/** What one source gave for a usage period. */
interface Attempt {
  resolution: Resolution | null
  /**
   * The store could not be read, so points it holds were not seen. The
   * result may be worse than the same configuration gives when the store
   * works.
   */
  storeUnread: boolean
}

const TIER_RANK: Record<QualityTier, number> = { A: 0, B: 1, C: 2, D: 3 }
const rankOf = (r: Resolution): number =>
  TIER_RANK[r.resolved.provenance.qualityTier]

/**
 * A result that ends the search: it covers the whole usage period at a tier
 * no worse than the best partial result so far. So a later source that
 * covers the period beats an earlier partial one, but the static source does
 * not beat partial live data (tier C over D).
 */
const isFinal = (
  r: Resolution | null,
  best: Resolution | null,
): r is Resolution =>
  r !== null && r.coverage === 1 && (!best || rankOf(r) <= rankOf(best))

/** The better of two results: the higher tier, then the higher coverage. */
const preferred = (
  best: Resolution | null,
  r: Resolution | null,
): Resolution | null => {
  if (!r) return best
  if (!best) return r
  if (rankOf(r) !== rankOf(best)) return rankOf(r) < rankOf(best) ? r : best
  return r.coverage > best.coverage ? r : best
}

/** The result, marked provisional when a later run could improve on it. */
const marked = (
  resolved: ResolvedIntensity,
  isProvisional: boolean,
): ResolvedIntensity =>
  isProvisional
    ? {
        ...resolved,
        provenance: { ...resolved.provenance, isProvisional: true },
      }
    : resolved

/**
 * Picks the best available source for each usage period and returns the
 * time-weighted intensity with provenance (section 6.2 of the design).
 *
 * Stored points are read before a source's lookback window or a recent
 * failure is considered: those limit what is fetched, not what is used.
 * A period a source had no usable point for is not asked for again within
 * the capability TTL.
 * A source that covers only part of the period is kept as a fallback while
 * later sources are tried. Failures stop a zone's fetches for the
 * capability TTL. Each warning is logged at most once per source, zone and
 * kind within the TTL, so the default resolver, which lives for the process
 * (one CLI run, or the life of the API server), logs a recurring failure
 * again each TTL.
 *
 * A result is marked provisional (ADR 0025) when one of the sources tried
 * for it could serve more of the period on a later run: see mayServeMore.
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
  private readonly statusCache = new Map<
    string,
    { status: SourceStatus; expiresAt: number }
  >()
  /** Zones whose fetches are stopped: until when, and why. */
  private readonly failures = new Map<
    string,
    { until: number; message: string }
  >()
  /** Warning id to the time it may be logged again. */
  private readonly warnedUntil = new Map<string, number>()
  /**
   * Periods a source was asked for and gave no usable point for, with the
   * time until which they are not asked for again. Nothing is stored for
   * such a period, and the resolver is called once per billing row, so
   * without this every row of the region and period would repeat the
   * request.
   */
  private readonly emptyUntil = new Map<string, number>()
  /** Stand-ins for capabilities that could not be probed (see capability()). */
  private readonly unprobed = new WeakSet<ZoneCapability>()
  /**
   * Points of session-retention sources, and preliminary points of every
   * source: never in the configured store, and released by the first
   * resolve call after the TTL.
   */
  private session = new InMemoryIntensityStore()
  private sessionExpiresAt = 0

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
    this.expireSession()
    const usageGranularity = usageGranularityOf(start, end)
    const fineEnough = coarsestWithin(start, end)

    // Step 2: sources fine enough for the usage period first, in order;
    // coarser ones only when none of those can serve it, finest first
    // (a live monthly value beats the static annual one), ties in order.
    // The first result that covers the period wins; failing that, the best
    // partial one.
    let best: Resolution | null = null
    // Whether a source tried so far could serve more of the period later.
    let mayImprove = false
    const coarser: Candidate[] = []
    for (const source of this.sources) {
      const candidate = await this.candidate(source, provider, region)
      if (!candidate) continue
      const finest = finestOf(candidate.capability.granularities)
      if (!isAtLeastAsFine(finest, fineEnough)) {
        coarser.push(candidate)
        continue
      }
      const attempt = await this.resolveFrom(
        candidate,
        start,
        end,
        usageGranularity,
      )
      const { resolution } = attempt
      mayImprove ||= this.mayServeMore(
        candidate,
        attempt,
        start,
        end,
        usageGranularity,
      )
      if (isFinal(resolution, best))
        return marked(resolution.resolved, mayImprove)
      best = preferred(best, resolution)
    }
    const rank = (c: Candidate) =>
      GRANULARITIES.indexOf(finestOf(c.capability.granularities))
    coarser.sort((a, b) => rank(a) - rank(b))
    for (const candidate of coarser) {
      const attempt = await this.resolveFrom(
        candidate,
        start,
        end,
        usageGranularity,
      )
      const { resolution } = attempt
      mayImprove ||= this.mayServeMore(
        candidate,
        attempt,
        start,
        end,
        usageGranularity,
      )
      if (isFinal(resolution, best))
        return marked(resolution.resolved, mayImprove)
      best = preferred(best, resolution)
    }
    if (best) return marked(best.resolved, mayImprove)
    throw new NoIntensityAvailableError(provider, region, mayImprove)
  }

  /**
   * Whether the source could serve more of the usage period on a later run
   * than it did on this one (ADR 0025). It could when settled points do not
   * cover the whole period and the part that is missing is one the source
   * can be asked for: not published yet, a gap, still preliminary, or not
   * fetched because a request failed. The resolver only asks for whole
   * periods of the granularity that start at or after the start of the
   * source's data, so what lies before the first such period will never be
   * served and does not count. Two cases cannot be judged and count as
   * able to serve more: the window is not known after a failed capability
   * probe, and stored points were not seen after a failed store read.
   */
  private mayServeMore(
    { capability }: Candidate,
    { resolution, storeUnread }: Attempt,
    start: Date,
    end: Date,
    usageGranularity: Granularity,
  ): boolean {
    const settled = (resolution?.resolved.points ?? []).filter(
      (point) => !point.isPreliminary,
    )
    const covers = (from: Date): boolean =>
      timeWeightedMean(settled, from, end)?.coverage === 1
    if (covers(start)) return false
    if (this.unprobed.has(capability) || storeUnread) return true
    const { earliest } = capability
    if (!earliest) return true
    const granularity = granularityFor(capability, end, usageGranularity)
    const boundary = startOfPeriod(earliest, granularity)
    const firstServed =
      boundary < earliest ? addPeriod(boundary, granularity) : boundary
    if (firstServed <= start) return true
    return firstServed < end && !covers(firstServed)
  }

  /**
   * What the resolver knows about each source for a region, in configured
   * order, for the capability report.
   */
  async sourceViews(
    provider: CloudProvider,
    region: string,
  ): Promise<SourceView[]> {
    const views: SourceView[] = []
    for (const source of this.sources) {
      const zoneId = source.mapRegion(provider, region)
      const capability = zoneId ? await this.capability(source, zoneId) : null
      const failure = zoneId ? this.failureOf(source.id, zoneId) : undefined
      views.push({
        source,
        zoneId,
        capability:
          capability && !this.unprobed.has(capability) ? capability : null,
        acknowledged: this.acknowledged.has(source.id),
        status: await this.status(source),
        ...(failure === undefined ? {} : { failure }),
      })
    }
    return views
  }

  /**
   * The source's probe answer, kept for the TTL so that a report does not
   * call the source every time. A probe that throws is an unreachable source.
   */
  private async status(source: GridIntensitySource): Promise<SourceStatus> {
    const nowMs = this.now().getTime()
    const cached = this.statusCache.get(source.id)
    if (cached && cached.expiresAt > nowMs) return cached.status
    let status: SourceStatus
    try {
      status = await source.probe()
    } catch (error) {
      status = {
        reachable: false,
        authenticated: false,
        message: messageOf(error),
      }
    }
    this.statusCache.set(source.id, { status, expiresAt: nowMs + this.ttlMs })
    return status
  }

  /** Steps 1 and 3: mapping, capability and licence checks. */
  private async candidate(
    source: GridIntensitySource,
    provider: CloudProvider,
    region: string,
  ): Promise<Candidate | null> {
    const zoneId = source.mapRegion(provider, region)
    if (!zoneId) return null
    const capability = await this.capability(source, zoneId)
    if (!capability || !capability.granularities.length) return null
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

  /**
   * The cached answer for the TTL. When a probe fails, the last answer is
   * kept for another TTL, so stored points stay usable while the zone's
   * fetches are stopped. With no earlier answer (a fresh process), a
   * stand-in with every granularity and the source's own licence is used,
   * and resolveFrom reads the store at each granularity.
   */
  private async capability(
    source: GridIntensitySource,
    zoneId: string,
  ): Promise<ZoneCapability | null> {
    const zoneRef = `${source.id}|${zoneId}`
    const nowMs = this.now().getTime()
    const cached = this.capabilityCache.get(zoneRef)
    if (cached && cached.expiresAt > nowMs) return cached.capability
    let capability: ZoneCapability | null
    try {
      capability = await source.capabilities(zoneId)
    } catch (error) {
      capability = cached?.capability ?? this.standIn(source, zoneId)
      this.fail(source, zoneId, 'capability probe', error)
    }
    this.capabilityCache.set(zoneRef, {
      capability,
      expiresAt: nowMs + this.ttlMs,
    })
    return capability
  }

  private standIn(source: GridIntensitySource, zoneId: string): ZoneCapability {
    const capability: ZoneCapability = {
      zoneId,
      granularities: [...GRANULARITIES],
      bases: [],
      licence: source.licence,
    }
    this.unprobed.add(capability)
    return capability
  }

  /** Steps 4 to 6: store, fetch what is missing, time-weight, provenance. */
  private async resolveFrom(
    candidate: Candidate,
    start: Date,
    end: Date,
    usageGranularity: Granularity,
  ): Promise<Attempt> {
    const { capability } = candidate
    if (this.unprobed.has(capability)) {
      // Fetches are stopped; use whatever granularity the store holds.
      let storeUnread = false
      for (const granularity of GRANULARITIES) {
        const attempt = await this.resolveAt(
          candidate,
          granularity,
          start,
          end,
          usageGranularity,
        )
        storeUnread ||= attempt.storeUnread
        if (attempt.resolution) return { ...attempt, storeUnread }
      }
      return { resolution: null, storeUnread }
    }
    const granularity = granularityFor(capability, end, usageGranularity)
    return this.resolveAt(candidate, granularity, start, end, usageGranularity)
  }

  private async resolveAt(
    { source, zoneId, capability }: Candidate,
    granularity: Granularity,
    start: Date,
    end: Date,
    usageGranularity: Granularity,
  ): Promise<Attempt> {
    const persist = source.persist !== false
    const store =
      capability.licence.retention === 'session' ? this.session : this.store
    const read = persist
      ? await this.storedPoints(
          store,
          source.id,
          zoneId,
          start,
          end,
          granularity,
        )
      : []
    const storeUnread = read === null
    const stored = read ?? []
    // Preliminary points fetched earlier in the TTL (ADR 0025).
    const held =
      persist && store !== this.session
        ? await this.session.get(source.id, zoneId, start, end, granularity)
        : []
    const fetched: IntensityPoint[] = []
    const seriesRef = `${source.id}|${zoneId}|${granularity}`
    const fetchable = this.failureOf(source.id, zoneId)
      ? []
      : periodsCovering(start, end, granularity).filter(
          (period) =>
            isWithinWindow(period, capability) &&
            !this.knownEmpty(seriesRef, period),
        )
    for (const range of missingPeriods(fetchable, [...held, ...stored])) {
      try {
        const points = await source.fetch(
          zoneId,
          range.start,
          range.end,
          granularity,
        )
        const usable = this.usablePoints(source, zoneId, granularity, points)
        fetched.push(...usable)
        this.rememberEmpty(
          seriesRef,
          missingPeriods(
            periodsCovering(range.start, range.end, granularity),
            usable,
          ),
          granularity,
        )
      } catch (error) {
        this.fail(source, zoneId, 'fetch', error)
        break
      }
    }
    if (persist) {
      // A preliminary point is kept in memory for the TTL, so the run does
      // not ask for it again, and never reaches the configured store: a
      // later run then fetches the settled value (ADR 0025).
      const storable = (point: IntensityPoint): boolean =>
        store === this.session || !point.isPreliminary
      const settled = fetched.filter(storable)
      const preliminary = fetched.filter((point) => !storable(point))
      if (settled.length)
        await this.storePoints(store, source.id, zoneId, settled)
      if (preliminary.length) await this.session.put(preliminary)
    }

    // For one period, in rising order of preference: a held preliminary
    // point, a preliminary point just fetched, a stored point, a settled
    // point just fetched. So a preliminary value never replaces a settled
    // one.
    const byStart = new Map<number, IntensityPoint>()
    for (const point of [
      ...held,
      ...fetched.filter((p) => p.isPreliminary),
      ...stored,
      ...fetched.filter((p) => !p.isPreliminary),
    ])
      byStart.set(point.periodStart.getTime(), point)
    const points = [...byStart.values()]
      .filter((p) => p.periodStart < end && p.periodEnd > start)
      .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime())

    const mean = timeWeightedMean(points, start, end)
    if (!mean) return { resolution: null, storeUnread }
    const isEstimated = mean.coverage < 1 || points.some((p) => p.isEstimated)
    const resolution: Resolution = {
      coverage: mean.coverage,
      resolved: {
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
      },
    }
    return { resolution, storeUnread }
  }

  /**
   * Drops points that are not whole UTC periods of the requested
   * granularity for this source and zone, so points cannot overlap and the
   * coverage cannot read 1 over a gap. The 0 to 1500 gCO2e/kWh bounds apply
   * to fetched data, not to values from code (persist false): CCF's GCP
   * multi-region factors are sums across data centres and exceed them.
   */
  private usablePoints(
    source: GridIntensitySource,
    zoneId: string,
    granularity: Granularity,
    points: IntensityPoint[],
  ): IntensityPoint[] {
    const whole = points.filter(
      (p) =>
        p.sourceId === source.id &&
        p.zoneId === zoneId &&
        p.granularity === granularity &&
        p.periodStart.getTime() ===
          startOfPeriod(p.periodStart, granularity).getTime() &&
        p.periodEnd.getTime() ===
          addPeriod(p.periodStart, granularity).getTime(),
    )
    this.warnDropped(
      `alignment|${source.id}|${zoneId}`,
      points.length - whole.length,
      `from grid intensity source ${source.id} for zone ${zoneId} that are not whole UTC ${granularity} periods of that zone.`,
    )
    if (source.persist === false) return whole
    const valid = whole.filter(
      (p) =>
        Number.isFinite(p.gCO2ePerKWh) &&
        p.gCO2ePerKWh >= 0 &&
        p.gCO2ePerKWh <= MAX_G_CO2E_PER_KWH,
    )
    this.warnDropped(
      `quality|${source.id}|${zoneId}`,
      whole.length - valid.length,
      `from grid intensity source ${source.id} for zone ${zoneId} outside 0 to ${MAX_G_CO2E_PER_KWH} gCO2e/kWh.`,
    )
    return valid
  }

  /** Whether the source gave nothing for the period within the TTL. */
  private knownEmpty(seriesRef: string, period: Period): boolean {
    const id = `${seriesRef}|${period.start.getTime()}`
    const until = this.emptyUntil.get(id)
    if (until === undefined) return false
    if (until > this.now().getTime()) return true
    this.emptyUntil.delete(id)
    return false
  }

  /** Notes each period of the ranges as asked for and not served. */
  private rememberEmpty(
    seriesRef: string,
    ranges: Period[],
    granularity: Granularity,
  ): void {
    const until = this.now().getTime() + this.ttlMs
    for (const range of ranges)
      for (const period of periodsCovering(range.start, range.end, granularity))
        this.emptyUntil.set(`${seriesRef}|${period.start.getTime()}`, until)
  }

  private warnDropped(id: string, dropped: number, rest: string): void {
    if (dropped > 0)
      this.warnOnce(
        id,
        `Dropped ${dropped} point${dropped === 1 ? '' : 's'} ${rest}`,
      )
  }

  /** Run at the start of every resolve call, whichever sources it uses. */
  private expireSession(): void {
    const nowMs = this.now().getTime()
    if (nowMs < this.sessionExpiresAt) return
    this.session = new InMemoryIntensityStore()
    this.sessionExpiresAt = nowMs + this.ttlMs
  }

  /** The failure that has stopped the zone's fetches, within the TTL. */
  private failureOf(sourceId: string, zoneId: string): string | undefined {
    const failure = this.failures.get(`${sourceId}|${zoneId}`)
    return failure && failure.until > this.now().getTime()
      ? failure.message
      : undefined
  }

  /** The stored points, or null when the store could not be read. */
  private async storedPoints(
    store: IntensityStore,
    sourceId: string,
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[] | null> {
    const warning = `store|read|${sourceId}|${zoneId}`
    try {
      const points = await store.get(sourceId, zoneId, start, end, granularity)
      // Working again: the next failure is news.
      this.warnedUntil.delete(warning)
      return points
    } catch (error) {
      this.warnOnce(
        warning,
        `Grid intensity store read failed for source ${sourceId}, zone ${zoneId}: ${messageOf(error)}`,
      )
      return null
    }
  }

  private async storePoints(
    store: IntensityStore,
    sourceId: string,
    zoneId: string,
    points: IntensityPoint[],
  ): Promise<void> {
    const warning = `store|write|${sourceId}|${zoneId}`
    try {
      await store.put(points)
      this.warnedUntil.delete(warning)
    } catch (error) {
      this.warnOnce(
        warning,
        `Grid intensity store write failed for source ${sourceId}, zone ${zoneId}: ${messageOf(error)}`,
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
    this.failures.set(zoneRef, {
      until: this.now().getTime() + this.ttlMs,
      message: `${operation} failed: ${messageOf(error)}`,
    })
    this.warnOnce(
      `failure|${zoneRef}`,
      `Grid intensity source ${source.id} ${operation} failed for zone ${zoneId}: ${messageOf(error)}. Skipping it for ${this.ttlMs / HOUR_MS} hours.`,
    )
  }

  /** At most once per id within the TTL. */
  private warnOnce(id: string, message: string): void {
    const nowMs = this.now().getTime()
    if ((this.warnedUntil.get(id) ?? 0) > nowMs) return
    this.warnedUntil.set(id, nowMs + this.ttlMs)
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

/**
 * The granularity to ask a source for, for a usage period ending at `end`.
 * A day or hour running past the end of the source's data (today) is served
 * from its finest data, so the part before `latest` is covered; the partial
 * coverage marks it estimated. Longer periods keep their usual granularity
 * and lose only the incomplete last period.
 */
export const granularityFor = (
  capability: ZoneCapability,
  end: Date,
  usageGranularity: Granularity,
): Granularity =>
  capability.latest &&
  end > capability.latest &&
  isAtLeastAsFine(usageGranularity, 'day')
    ? finestOf(capability.granularities)
    : requestGranularity(capability.granularities, usageGranularity)

/** Whether the source can be asked for the whole period. */
export const isWithinWindow = (
  period: Period,
  capability: ZoneCapability,
): boolean =>
  (!capability.earliest || period.start >= capability.earliest) &&
  (!capability.latest || period.end <= capability.latest)

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
