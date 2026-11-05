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

/** The user name and password in a MongoDB URI, raw and decoded. */
const credentialsIn = (uri: string): string[] => {
  const scheme = uri.indexOf('://')
  const at = uri.lastIndexOf('@')
  if (scheme < 0 || at < scheme) return []
  const userinfo = uri.slice(scheme + 3, at)
  const colon = userinfo.indexOf(':')
  const parts =
    colon < 0
      ? [userinfo]
      : [userinfo.slice(0, colon), userinfo.slice(colon + 1)]
  const decoded = parts.map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
  return [...parts, ...decoded].filter((part) => part.length > 0)
}

/**
 * A driver error message that is safe to log. The driver quotes the whole
 * connection string in some parse errors and the user name in another, so
 * the userinfo of any MongoDB URI in the message is replaced, and if a user
 * name or password from MONGODB_URI is still in it, only the error's name is
 * kept.
 */
const withoutCredentials = (error: Error, uri: string): string => {
  const message = error.message.replace(
    /(mongodb(?:\+srv)?:\/\/)[^/]*@/g,
    '$1<credentials>@',
  )
  return credentialsIn(uri).some((secret) => message.includes(secret))
    ? `${error.name} (message not shown because it contains credentials from MONGODB_URI)`
    : message
}

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
    if (mongodb.URI) {
      // The driver parses the URI and reads the credentials file here, so a
      // malformed MONGODB_URI or a missing MONGODB_CREDENTIALS file throws
      // before any connection is made.
      try {
        return MongoDbIntensityStore.fromConnectionString(
          mongodb.URI,
          mongodb.CREDENTIALS || undefined,
        )
      } catch (error) {
        logger.warn(
          `GRID_INTENSITY_STORE is MONGODB but the MongoDB client could not be created from MONGODB_URI and MONGODB_CREDENTIALS: ${withoutCredentials(error as Error, mongodb.URI)}. Grid intensity points are kept in memory for this run only.`,
        )
        return new InMemoryIntensityStore()
      }
    }
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
