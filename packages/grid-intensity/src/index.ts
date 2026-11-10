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
export { StaticSource } from './sources/StaticSource'
export type {
  StaticFactors,
  StaticFactorTable,
  StaticFactorTables,
} from './sources/StaticSource'
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
  ElectricityMapsRequestError,
  isElectricityMapsRequestError,
  LEGACY_ELECTRICITY_MAPS_SOURCE_ID,
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
export type {
  EmissionsFactorsResolution,
  ResolveEmissionsFactorsOptions,
} from './resolveEmissionsFactors'
