/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

export type * from './types'
export {
  GRANULARITIES,
  addPeriod,
  isAtLeastAsFine,
  periodsCovering,
  startOfPeriod,
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
