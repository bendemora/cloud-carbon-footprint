/*
 * © 2021 Thoughtworks, Inc.
 */

import { reduceBy } from 'ramda'
import { GroupBy } from './Config'
import { getPeriodEndDate } from './helpers'
import { Provenance } from './Provenance'

export interface EstimationResult {
  readonly timestamp: Date
  readonly serviceEstimates: ServiceData[]
  periodStartDate?: Date
  periodEndDate?: Date
  groupBy: GroupBy
}

export interface ServiceData {
  readonly cloudProvider: string
  /**
   * A legacy total (ADR 0024), not an energy measure: the electricity the
   * usage is modelled to consume, plus its embodied emissions expressed as
   * energy at the grid factor applied to the row. With the static factors
   * that addition is fixed for a region; with a live intensity it grows as
   * the grid gets cleaner. operationalKilowattHours is the energy.
   */
  readonly kilowattHours: number
  /** Metric tons CO2e, operational and embodied together. */
  readonly co2e: number
  readonly cost: number
  readonly usesAverageCPUConstant?: boolean
  readonly accountId: string
  // these attributes are mutable because it is required by the client package
  accountName: string
  serviceName: string
  region: string
  tags?: TagCollection
  /**
   * Where the grid intensity came from. Set on AWS, GCP and Azure estimates
   * from billing data. Absent on estimates from the cloud usage APIs (billing
   * data turned off), on rows cached before it was recorded, and on Alibaba
   * Cloud and on-premise rows.
   */
  provenance?: Provenance
  /**
   * The electricity the usage is modelled to consume, PUE and replication
   * included, in kilowatt hours (ADR 0024). Set on AWS, GCP, Azure and
   * Alibaba Cloud estimates from billing data, together with embodiedCo2e.
   * Absent on estimates from the cloud usage APIs, on rows cached before it
   * was recorded, and on a row with no co2e value.
   */
  readonly operationalKilowattHours?: number
  /**
   * The metric tons CO2e from hardware manufacturing attributed to the usage
   * (ADR 0024). Operational emissions are co2e less this. For a row with
   * both fields, and g the grid intensity of its provenance in gCO2e/kWh,
   * co2e = operationalKilowattHours x g / 1e6 + embodiedCo2e. On AWS and
   * Azure, usage estimated from the average of known usage inherits a share
   * of the known rows' embodied emissions, which moves with the grid
   * factors (a known fault, ADR 0024).
   */
  readonly embodiedCo2e?: number
}

export interface TagCollection {
  [index: string]: string
}

export const reduceByTimestamp = (
  estimationResults: EstimationResult[],
): EstimationResult[] => {
  // We need this mutable type in order to set the first timestamp based on the estimationResults values.
  interface MutableEstimationResult {
    timestamp: Date | undefined
    serviceEstimates: ServiceData[]
    periodStartDate: Date
    periodEndDate: Date
    groupBy: GroupBy
  }

  const accumulatingFn = (
    acc: MutableEstimationResult,
    value: MutableEstimationResult,
  ) => {
    acc.timestamp = acc.timestamp || new Date(value.timestamp)
    acc.serviceEstimates = acc.serviceEstimates.concat(value.serviceEstimates)
    acc.groupBy = acc.groupBy || value.groupBy
    acc.periodStartDate = acc.timestamp || new Date(value.timestamp)
    acc.periodEndDate = getPeriodEndDate(acc.periodStartDate, acc.groupBy)
    return acc
  }
  const getTimeOfEstimate = (estimationResult: { timestamp: Date }) =>
    estimationResult.timestamp.toISOString()

  const result = reduceBy(
    accumulatingFn,
    {
      timestamp: undefined,
      serviceEstimates: [],
      periodStartDate: undefined,
      periodEndDate: undefined,
      groupBy: undefined,
    },
    getTimeOfEstimate,
    estimationResults,
  )

  return Object.values(result)
}
