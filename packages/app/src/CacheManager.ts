/*
 * © 2021 Thoughtworks, Inc.
 */

import moment, { Moment } from 'moment'
import {
  EstimationResult,
  Logger,
  QualityTier,
} from '@cloud-carbon-footprint/common'
import { EstimationRequest } from './CreateValidRequest'

/**
 * The worst quality tier among the rows of one cloud provider and region
 * that carry provenance. A is the best tier and D the worst.
 */
export interface WorstTier {
  cloudProvider: string
  region: string
  qualityTier: QualityTier
}

/** A period the cache holds: one estimation result, known by its timestamp. */
export interface CachedPeriod {
  timestamp: Date
  /**
   * True when at least one row of the period has provenance.isProvisional
   * set to true (ADR 0025). Rows cached before the marker existed have none,
   * so their periods count as final.
   */
  isProvisional: boolean
  /**
   * The worst quality tier of the period's rows, for each cloud provider and
   * region that has rows with provenance. A refresh compares it with the
   * tiers of a new estimate, so that it does not put worse rows in the place
   * of better ones. Rows without provenance are not in it.
   */
  worstTiers: WorstTier[]
}

/** A range of timestamps. Both ends belong to it. */
export interface DateRange {
  startDate: Date
  endDate: Date
}

export default abstract class CacheManager {
  protected readonly cacheLogger: Logger

  protected constructor() {
    this.cacheLogger = new Logger('Cache')
  }

  /**
   * Returns cached estimates for the given request and grouping.
   *
   * @param request  Request the client is making
   * @param grouping String representing how the data is being grouped
   */
  abstract getEstimates(
    request: EstimationRequest,
    grouping: string,
  ): Promise<EstimationResult[]>

  /**
   * Sets cached estimates to the cache implementation.
   *
   * @param data     Data to be cached
   * @param grouping String representing how the data is being grouped
   */
  abstract setEstimates(data: EstimationResult[], grouping: string): void

  abstract getMissingDates(
    request: EstimationRequest,
    grouping: string,
  ): Promise<Moment[]>

  /**
   * Replaces cached rows (ADR 0025). For each period in the estimates (one
   * estimation result, known by its timestamp), the cached rows of that
   * period that belong to the given cloud providers are removed and the rows
   * of the estimates for that period take their place. Providers are compared
   * without regard to case. With no cloudProviders, every row of those
   * periods is replaced. A period that is not cached yet is added, and
   * periods that are not in the estimates are left as they are.
   *
   * Unlike setEstimates it fails when the cache cannot be read or written, so
   * that the caller knows the rows were not replaced.
   *
   * @param estimates      The periods to put in the cache
   * @param grouping       String representing how the data is being grouped
   * @param cloudProviders The providers whose cached rows are replaced
   */
  abstract replaceEstimates(
    estimates: EstimationResult[],
    grouping: string,
    cloudProviders?: string[],
  ): Promise<void>

  /**
   * The periods the cache holds for the grouping, oldest first: whether each
   * holds provisional rows, and the worst quality tier of its rows by cloud
   * provider and region. With a range, only the periods whose timestamp lies
   * in it. It reads the cache and creates nothing: a grouping with no cache
   * file, object or collection has no periods.
   *
   * @param grouping String representing how the data is being grouped
   * @param range    The timestamps to look at, when not all of them
   */
  abstract getCachedPeriods(
    grouping: string,
    range?: DateRange,
  ): Promise<CachedPeriod[]>

  /**
   * Where the cache of the grouping is kept, for messages: the file, the
   * object or the collection.
   *
   * @param grouping String representing how the data is being grouped
   */
  abstract locationOf(grouping: string): string

  protected filterEstimatesForRequest(
    request: EstimationRequest,
    estimates: EstimationResult[],
  ) {
    const startDate = moment.utc(request.startDate)
    const endDate = moment.utc(request.endDate)

    return estimates.filter(({ timestamp }) => {
      return moment
        .utc(timestamp)
        .isBetween(startDate, endDate, undefined, '[]')
    })
  }
}
