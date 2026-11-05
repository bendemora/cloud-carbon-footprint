/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CCFConfig } from '@cloud-carbon-footprint/common'
import type { ResolverLogger } from '../GridIntensityResolver'
import type { IntensityStore } from '../types'
import { InMemoryIntensityStore } from './InMemoryIntensityStore'
import { DEFAULT_STORE_PATH, LocalIntensityStore } from './LocalIntensityStore'
import { MongoDbIntensityStore } from './MongoDbIntensityStore'

/**
 * The store GRID_INTENSITY_STORE selects (design section 6.6). LOCAL is the
 * default. A misconfiguration warns and keeps points in memory for the run,
 * so files are never written somewhere the operator did not choose.
 */
export const createIntensityStore = (
  gridIntensity: CCFConfig['GRID_INTENSITY'] = {},
  mongodb: CCFConfig['MONGODB'] = {},
  logger: ResolverLogger,
): IntensityStore => {
  const mode = gridIntensity.STORE ?? 'LOCAL'
  if (mode === 'LOCAL')
    return new LocalIntensityStore(
      gridIntensity.STORE_PATH || DEFAULT_STORE_PATH,
    )
  if (mode === 'MONGODB') {
    if (mongodb.URI)
      return MongoDbIntensityStore.fromConnectionString(
        mongodb.URI,
        mongodb.CREDENTIALS || undefined,
      )
    logger.warn(
      'GRID_INTENSITY_STORE is MONGODB but MONGODB_URI is not set. Grid intensity points are kept in memory for this run only.',
    )
    return new InMemoryIntensityStore()
  }
  logger.warn(
    `Unknown GRID_INTENSITY_STORE '${mode}'. Use LOCAL or MONGODB. Grid intensity points are kept in memory for this run only.`,
  )
  return new InMemoryIntensityStore()
}
