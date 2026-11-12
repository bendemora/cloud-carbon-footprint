/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

export type * from './types'
export {
  GRANULARITIES,
  addPeriod,
  addUtcMonths,
  isAtLeastAsFine,
  periodsCovering,
  startOfPeriod,
  usageGranularityOf,
} from './granularity'
export type { Period } from './granularity'
export { requiresAcknowledgement } from './licence'
export { STATIC_SOURCE_ID, deriveQualityTier } from './qualityTier'
export type { QualityTierInput } from './qualityTier'
export { gramsToTonnes, tonnesToGrams } from './units'
export {
  GRID_ZONE_REGISTRY_VERSION,
  GRID_ZONES,
  gridZoneOf,
} from './registry/gridZones'
export type { GridZoneMap } from './registry/gridZones'
export { StaticSource } from './sources/StaticSource'
export type {
  StaticFactors,
  StaticFactorTable,
  StaticFactorTables,
} from './sources/StaticSource'
export {
  NESO_HOLD_BACK_HOURS,
  NESO_MIN_REQUEST_INTERVAL_MS,
  NESO_SOURCE_ID,
  NESO_ZONES,
  NesoSource,
} from './sources/NesoSource'
export type { NesoSourceOptions } from './sources/NesoSource'
export { missingPeriods, timeWeightedMean } from './coverage'
export type { WeightedMean } from './coverage'
export { InMemoryIntensityStore } from './stores/InMemoryIntensityStore'
export {
  GridIntensityResolver,
  NoIntensityAvailableError,
} from './GridIntensityResolver'
export type {
  GridIntensityResolverOptions,
  ResolverLogger,
  SourceView,
} from './GridIntensityResolver'
export { GridIntensityCapabilityReporter } from './CapabilityReporter'
export type { CapabilityReporterOptions } from './CapabilityReporter'
export {
  createCapabilityReporter,
  lastFullUtcDay,
  resetDefaultResolver,
  resolveEmissionsFactors,
  shutdownDefaultResolver,
  usagePeriod,
} from './resolveEmissionsFactors'
export {
  DEFAULT_STORE_PATH,
  LocalIntensityStore,
} from './stores/LocalIntensityStore'
export {
  MONGODB_COLLECTION,
  MONGODB_DATABASE,
  MongoDbIntensityStore,
} from './stores/MongoDbIntensityStore'
export { createIntensityStore } from './stores/createIntensityStore'
export { RECENT_READ_MS, RecentReadsStore } from './stores/RecentReadsStore'
export { PartialFetchError, partialPointsOf } from './PartialFetchError'
export { MAX_G_CO2E_PER_KWH } from './dataQuality'
export type {
  CapabilityReporterInput,
  EmissionsFactorsResolution,
  ResolveEmissionsFactorsOptions,
} from './resolveEmissionsFactors'
