/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { configLoader, GroupBy } from '@cloud-carbon-footprint/common'
import CacheManager from './CacheManager'
import GoogleCloudCacheManager from './GoogleCloudCacheManager'
import LocalCacheManager from './LocalCacheManager'
import MongoDbCacheManager from './MongoDbCacheManager'

/**
 * A manager for the estimates cache that CACHE_MODE selects: GCS, MONGODB,
 * or the local file for any other value, which is how the @cache() decorator
 * chooses. With MONGODB the connection must have been created already
 * (MongoDbCacheManager.createDbConnection), as for estimates.
 */
export const createCacheManager = (): CacheManager => {
  switch (configLoader().CACHE_MODE) {
    case 'GCS':
      return new GoogleCloudCacheManager()
    case 'MONGODB':
      return new MongoDbCacheManager()
    default:
      return new LocalCacheManager()
  }
}

/** What the estimates cache holds for one grouping. */
export interface CachedPeriodCount {
  groupBy: GroupBy
  /** The number of periods the cache holds for the grouping. */
  cachedPeriods: number
  /** How many of them hold at least one provisional row (ADR 0025). */
  provisionalPeriods: number
}

/**
 * For each grouping that the estimates cache holds periods of: how many
 * periods, and how many of them hold provisional rows. A grouping with
 * nothing cached is left out, so the answer is empty when there is no cache.
 * It reads the whole cache, one grouping at a time. It calls no cloud
 * provider and no grid intensity source.
 */
export const countCachedPeriods = async (
  cacheManager: CacheManager = createCacheManager(),
): Promise<CachedPeriodCount[]> => {
  const counts: CachedPeriodCount[] = []
  for (const groupBy of Object.values(GroupBy)) {
    const periods = await cacheManager.getCachedPeriods(groupBy)
    if (periods.length)
      counts.push({
        groupBy,
        cachedPeriods: periods.length,
        provisionalPeriods: periods.filter(({ isProvisional }) => isProvisional)
          .length,
      })
  }
  return counts
}
