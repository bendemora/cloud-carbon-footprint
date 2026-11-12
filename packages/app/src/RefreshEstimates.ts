/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import moment from 'moment'
import {
  EstimationResult,
  GroupBy,
  Logger,
  QualityTier,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import CacheManager, { CachedPeriod } from './CacheManager'
import { isWorseTier, regionIdOf, worstTiersOf } from './common/helpers'
import { EstimationRequest } from './CreateValidRequest'
import { createCacheManager } from './EstimatesCache'

export interface RefreshRequest {
  /** The first timestamp of the range to look at. */
  startDate: Date
  /** The last timestamp of the range. A period that starts on it is in. */
  endDate: Date
  groupBy: GroupBy
  /** Refresh every cached period in the range, not only provisional ones. */
  includeFinal?: boolean
  /** Estimate one cloud provider only (aws, gcp or azure), as seeding does. */
  cloudProviderToSeed?: string
}

/** A run of adjacent periods that could not be refreshed. */
export interface RefreshFailure {
  /** The timestamp of the first period of the run. */
  startDate: Date
  /** The end of the last period of the run. */
  endDate: Date
  /** How many periods of the run were not refreshed because it failed. */
  periods: number
  /** The message of the error that ended the run. */
  error: string
}

/**
 * What a refresh did. Each cached period it set out to refresh is counted
 * once: as refreshed, as left alone because the new estimate was empty, as
 * kept because the new estimate was worse, or among the periods of a failed
 * run.
 */
export interface RefreshSummary {
  groupBy: GroupBy
  /** Where the cache is kept: a file, an object or a collection. */
  cache: string
  /** The number of cached periods whose timestamp lies in the range. */
  cachedPeriods: number
  /** How many of them held provisional rows before the refresh. */
  provisionalBefore: number
  /** Runs of adjacent periods to refresh. Each is one estimation request. */
  runs: number
  /** Periods whose cached rows were replaced by the rows of a new estimate. */
  refreshedPeriods: number
  /** Periods left as they were because the new estimate had no rows for them. */
  emptyPeriods: number
  /**
   * Periods that kept the cached rows of at least one cloud provider,
   * because the new estimate had a worse quality tier than the cache for one
   * of that provider's regions. A grid intensity source may have been out of
   * reach during the run. The rows of other providers of such a period are
   * replaced all the same.
   */
  keptBecauseWorse: number
  /** How many cached periods in the range hold provisional rows afterwards. */
  provisionalAfter: number
  /** The runs that failed. */
  failedRuns: RefreshFailure[]
}

/** The estimation that the @cache() decorator wraps, without the cache. */
export type EstimateWithoutCache = (
  request: EstimationRequest,
) => Promise<EstimationResult[]>

/** Adjacent periods, estimated again with one request. */
interface Run {
  periods: Date[]
  startDate: Date
  endDate: Date
}

/** New rows for some periods, to replace the cached rows of the providers. */
interface Replacement {
  cloudProviders: string[]
  estimates: EstimationResult[]
  /** How many of the periods are replaced for every provider with new rows. */
  wholePeriods: number
}

/** What the new estimate of a run means for the cache. */
interface RunPlan {
  replacements: Replacement[]
  /** Periods of the run that the new estimate has no rows for. */
  emptyPeriods: number
  /** Periods that keep the cached rows of at least one provider. */
  keptPeriods: number
}

/** Rows that stay in the cache because the new ones are worse. */
interface KeptRows {
  timestamp: Date
  cloudProvider: string
  region: string
  cachedTier: QualityTier
  newTier: QualityTier
}

/**
 * Groups period timestamps, oldest first, into runs in which each period
 * starts where the one before it ends. A run ends with its last period: a
 * week grouping has ISO weeks, which start on Mondays, as the providers'
 * queries and getDatesWithinRequestTimeFrame have them.
 */
const runsOf = (timestamps: Date[], groupBy: GroupBy): Run[] => {
  const unit = (
    groupBy === GroupBy.week ? 'isoWeek' : groupBy
  ) as moment.unitOfTime.StartOf
  const runs: Date[][] = []
  for (const timestamp of timestamps) {
    const run = runs[runs.length - 1]
    const follows =
      run &&
      moment
        .utc(run[run.length - 1])
        .add(1, groupBy as moment.unitOfTime.DurationConstructor)
        .isSame(timestamp)
    if (follows) run.push(timestamp)
    else runs.push([timestamp])
  }
  return runs.map((periods) => ({
    periods,
    startDate: periods[0],
    endDate: moment
      .utc(periods[periods.length - 1])
      .endOf(unit)
      .toDate(),
  }))
}

/**
 * The periods of a run that the new estimate has rows for, by timestamp. A
 * period the run did not ask for is left out, because a refresh never fills
 * gaps. Results that share a timestamp are the rows of one period.
 */
const newPeriodsOf = (
  run: Run,
  estimates: EstimationResult[],
): Map<number, EstimationResult> => {
  const wanted = new Set(run.periods.map((period) => period.getTime()))
  const newPeriods = new Map<number, EstimationResult>()
  for (const estimate of estimates) {
    const time = new Date(estimate.timestamp).getTime()
    if (!wanted.has(time) || !estimate.serviceEstimates.length) continue
    const sameTime = newPeriods.get(time)
    newPeriods.set(
      time,
      sameTime
        ? {
            ...sameTime,
            serviceEstimates: sameTime.serviceEstimates.concat(
              estimate.serviceEstimates,
            ),
          }
        : estimate,
    )
  }
  return newPeriods
}

/**
 * The first region in which the new rows of a cloud provider have a worse
 * quality tier than the cached rows of that provider, if there is one. The
 * tier of a region is the worst among its rows that carry provenance. A
 * region is compared only when both the cached and the new rows of it have
 * provenance, so rows without provenance stand in the way of nothing.
 */
const worseThanCached = (
  cached: CachedPeriod,
  newRows: ServiceData[],
): Omit<KeptRows, 'timestamp'> | undefined => {
  const cachedTiers = new Map<string, QualityTier>()
  for (const { cloudProvider, region, qualityTier } of cached.worstTiers) {
    const regionId = regionIdOf(cloudProvider, region)
    const known = cachedTiers.get(regionId)
    if (!known || isWorseTier(qualityTier, known))
      cachedTiers.set(regionId, qualityTier)
  }
  for (const { cloudProvider, region, qualityTier } of worstTiersOf(newRows)) {
    const cachedTier = cachedTiers.get(regionIdOf(cloudProvider, region))
    if (cachedTier && isWorseTier(qualityTier, cachedTier))
      return { cloudProvider, region, cachedTier, newTier: qualityTier }
  }
  return undefined
}

/**
 * What to do with the cache after a run was estimated again.
 *
 * Each period the new estimate has rows for is judged one cloud provider at
 * a time. The new rows of a provider replace its cached rows, unless they
 * are worse in some region (worseThanCached): then the cached rows of that
 * provider stay and its new rows are dropped. The periods are grouped by the
 * providers whose rows are replaced, one replacement for each group.
 */
const planOf = (
  run: Run,
  estimates: EstimationResult[],
  cachedPeriods: Map<number, CachedPeriod>,
  onKept: (kept: KeptRows) => void,
): RunPlan => {
  const newPeriods = newPeriodsOf(run, estimates)
  const replacements = new Map<string, Replacement>()
  let keptPeriods = 0

  for (const [time, estimate] of newPeriods) {
    const rowsOfProvider = new Map<string, ServiceData[]>()
    for (const row of estimate.serviceEstimates) {
      const provider = row.cloudProvider.toUpperCase()
      const rows = rowsOfProvider.get(provider)
      if (rows) rows.push(row)
      else rowsOfProvider.set(provider, [row])
    }

    const keptProviders = new Set<string>()
    for (const [provider, rows] of rowsOfProvider) {
      const worse = worseThanCached(cachedPeriods.get(time), rows)
      if (!worse) continue
      keptProviders.add(provider)
      onKept({ timestamp: new Date(time), ...worse })
    }
    if (keptProviders.size) keptPeriods++

    const newRows = estimate.serviceEstimates.filter(
      (row) => !keptProviders.has(row.cloudProvider.toUpperCase()),
    )
    if (!newRows.length) continue
    const cloudProviders = [
      ...new Set(newRows.map((row) => row.cloudProvider)),
    ].sort()
    const providerSet = JSON.stringify(cloudProviders)
    const replacement = replacements.get(providerSet) ?? {
      cloudProviders,
      estimates: [],
      wholePeriods: 0,
    }
    replacement.estimates.push(
      keptProviders.size
        ? { ...estimate, serviceEstimates: newRows }
        : estimate,
    )
    if (!keptProviders.size) replacement.wholePeriods++
    replacements.set(providerSet, replacement)
  }

  return {
    replacements: [...replacements.values()],
    emptyPeriods: run.periods.length - newPeriods.size,
    keptPeriods,
  }
}

const countProvisional = (periods: { isProvisional: boolean }[]): number =>
  periods.filter(({ isProvisional }) => isProvisional).length

/**
 * Estimates cached periods again and replaces them in the estimates cache
 * (ADR 0025, point 3).
 *
 * It looks at the cached periods of the grouping whose timestamp lies in the
 * range, and refreshes the ones that hold provisional rows, or all of them
 * with includeFinal. A period that is not cached is not its business: it
 * never fills gaps.
 *
 * The periods to refresh are grouped into runs of adjacent periods, and each
 * run is estimated with one request, one run after the other. For a period
 * that the new estimate has rows for, the cached rows of the providers of
 * those rows are replaced. Rows of a provider that the new estimate returned
 * nothing for stay, so a provider that is no longer configured keeps its
 * rows. A period with no new rows at all is left as it is.
 *
 * It never puts worse rows in the place of better ones. When a grid
 * intensity source cannot be reached, a new estimate falls back to a
 * lower-ranked source or to the static factors. So where the new rows of a
 * provider have a worse quality tier than its cached rows in some region,
 * the cached rows of that provider stay for that period.
 *
 * A run whose estimation or replacement fails is reported in the summary and
 * the other runs still go ahead. A failed estimation leaves the cache as it
 * was. It fails as a whole only when the cache cannot be read.
 *
 * @param request      The range, the grouping and what to refresh
 * @param estimate     The estimation to run again, without the cache
 * @param cacheManager The cache to refresh: by default the configured one
 */
export const refreshCachedEstimates = async (
  request: RefreshRequest,
  estimate: EstimateWithoutCache,
  cacheManager: CacheManager = createCacheManager(),
): Promise<RefreshSummary> => {
  const logger = new Logger('Refresh')
  const { groupBy, cloudProviderToSeed } = request
  const range = { startDate: request.startDate, endDate: request.endDate }

  const cached = await cacheManager.getCachedPeriods(groupBy, range)
  const cachedPeriods = new Map(
    cached.map((period) => [period.timestamp.getTime(), period]),
  )
  const provisionalBefore = countProvisional(cached)
  const toRefresh = request.includeFinal
    ? cached
    : cached.filter(({ isProvisional }) => isProvisional)
  const runs = runsOf(
    toRefresh.map(({ timestamp }) => timestamp),
    groupBy,
  )

  const summary: RefreshSummary = {
    groupBy,
    cache: cacheManager.locationOf(groupBy),
    cachedPeriods: cached.length,
    provisionalBefore,
    runs: runs.length,
    refreshedPeriods: 0,
    emptyPeriods: 0,
    keptBecauseWorse: 0,
    provisionalAfter: provisionalBefore,
    failedRuns: [],
  }

  const warnOfKeptRows = (kept: KeptRows) =>
    logger.warn(
      `Kept the cached ${kept.cloudProvider} rows of ${kept.timestamp.toISOString()}: the new estimate has quality tier ${kept.newTier} for ${kept.region}, where the cache has ${kept.cachedTier}. A grid intensity source may have been out of reach.`,
    )

  let cacheMayHaveChanged = false
  for (const run of runs) {
    const span = `${run.startDate.toISOString()} to ${run.endDate.toISOString()}`
    // The periods that count as failed if the run fails from here on.
    let notRefreshed = run.periods.length
    let refreshed = 0
    try {
      logger.info(
        `Estimating ${run.periods.length} cached period(s) again: ${span}`,
      )
      const estimates = await estimate({
        startDate: run.startDate,
        endDate: run.endDate,
        ignoreCache: true,
        groupBy,
        cloudProviderToSeed,
      })
      const plan = planOf(run, estimates, cachedPeriods, warnOfKeptRows)
      summary.emptyPeriods += plan.emptyPeriods
      summary.keptBecauseWorse += plan.keptPeriods
      notRefreshed -= plan.emptyPeriods + plan.keptPeriods
      for (const replacement of plan.replacements) {
        cacheMayHaveChanged = true
        await cacheManager.replaceEstimates(
          replacement.estimates,
          groupBy,
          replacement.cloudProviders,
        )
        refreshed += replacement.wholePeriods
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`The refresh of ${span} failed: ${message}`)
      summary.failedRuns.push({
        startDate: run.startDate,
        endDate: run.endDate,
        periods: notRefreshed - refreshed,
        error: message,
      })
    }
    summary.refreshedPeriods += refreshed
  }

  if (cacheMayHaveChanged)
    summary.provisionalAfter = countProvisional(
      await cacheManager.getCachedPeriods(groupBy, range),
    )
  return summary
}
