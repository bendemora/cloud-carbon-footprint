/*
 * © 2021 Thoughtworks, Inc.
 */

import { median, reduceBy } from 'ramda'

import { COMPUTE_PROCESSOR_TYPES } from './compute'
import { BillingDataRow, CloudConstantsEmissionsFactors } from '.'
import {
  GroupBy,
  getPeriodEndDate,
  Provenance,
  TagCollection,
} from '@cloud-carbon-footprint/common'
import { mergeProvenance } from './provenance'

export default interface FootprintEstimate {
  timestamp: Date
  /**
   * A legacy total (ADR 0024), not an energy measure: the electricity the
   * usage is modelled to consume, plus its embodied emissions expressed as
   * energy at the grid factor applied to the row. operationalKilowattHours
   * is the energy.
   */
  kilowattHours: number
  /** Metric tons CO2e, operational and embodied together. */
  co2e: number
  usesAverageCPUConstant?: boolean
  /** Where the grid intensity behind co2e came from. */
  provenance?: Provenance
  /**
   * The electricity the usage is modelled to consume, PUE and replication
   * included, in kilowatt hours (ADR 0024).
   */
  operationalKilowattHours?: number
  /**
   * The metric tons CO2e from hardware manufacturing attributed to the
   * usage (ADR 0024). Operational emissions are co2e less this.
   */
  embodiedCo2e?: number
}

/**
 * Marks an estimate whose energy is all electricity consumed and whose
 * emissions are all operational: storage, networking, memory, and compute
 * with no embodied part (ADR 0024). An estimate that already has either
 * field is returned as it is, and so is one with no co2e value (an AWS
 * instance type that cannot be sized), which has nothing to split.
 */
export const asOperationalEstimate = <Estimate extends FootprintEstimate>(
  estimate: Estimate,
): Estimate => {
  if (
    estimate.operationalKilowattHours !== undefined ||
    estimate.embodiedCo2e !== undefined ||
    !Number.isFinite(estimate.co2e)
  )
    return estimate
  return {
    ...estimate,
    operationalKilowattHours: estimate.kilowattHours,
    embodiedCo2e: 0,
  }
}

export type KilowattHourTotals = {
  usageAmount?: number
  cost?: number
  /** The legacy total, embodied emissions expressed as energy included. */
  kilowattHours: number
  /**
   * The operational energy alone (ADR 0024). Recorded once it differs from
   * kilowattHours; a total without it is read as all operational.
   */
  operationalKilowattHours?: number
}

export type KilowattHoursByServiceAndUsageUnit = {
  [key: string]: {
    [key: string]: KilowattHourTotals
  }
}

export enum AccumulateKilowattHoursBy {
  COST = 'cost',
  USAGE_AMOUNT = 'usageAmount',
}

export const aggregateEstimatesByDay = (
  estimates: FootprintEstimate[],
): { [date: string]: FootprintEstimate } => {
  const getDayOfEstimate = (estimate: { timestamp: Date }) =>
    estimate.timestamp.toISOString().substr(0, 10)

  const accumulatingFn = (acc: FootprintEstimate, value: FootprintEstimate) => {
    if (acc.timestamp.getTime() === new Date(0).getTime()) {
      acc.timestamp = new Date(getDayOfEstimate(value))
    }
    acc.kilowattHours += value.kilowattHours
    acc.co2e += value.co2e
    if (value.usesAverageCPUConstant) {
      acc.usesAverageCPUConstant =
        acc.usesAverageCPUConstant || value.usesAverageCPUConstant
    }
    return acc
  }

  return reduceBy(
    accumulatingFn,
    {
      kilowattHours: 0,
      co2e: 0,
      timestamp: new Date(0),
      usesAverageCPUConstant: false,
    },
    getDayOfEstimate,
    estimates,
  )
}

export interface MutableEstimationResult {
  timestamp: Date
  serviceEstimates: MutableServiceEstimate[]
  periodStartDate: Date
  periodEndDate: Date
  groupBy: GroupBy
}

export interface MutableServiceEstimate {
  cloudProvider: string
  accountId: string
  accountName: string
  serviceName: string
  kilowattHours: number
  co2e: number
  cost: number
  region: string
  usesAverageCPUConstant: boolean
  tags?: TagCollection
  provenance?: Provenance
  operationalKilowattHours?: number
  embodiedCo2e?: number
}

/**
 * Adds a row's energy to the running averages that unknown usage is
 * estimated from. kilowattHours is what the provider puts in the average:
 * the row's legacy total on AWS and Azure, and the energy of the row's
 * compute, storage or memory on Google Cloud, which leaves embodied
 * emissions out. When it holds embodied emissions,
 * operationalKilowattHours is the energy without them (ADR 0024); it
 * defaults to kilowattHours.
 */
export const accumulateKilowattHours = (
  kilowattHoursByServiceAndUsageUnit: KilowattHoursByServiceAndUsageUnit,
  billingDataRow: BillingDataRow,
  kilowattHours: number,
  accumulateBy: AccumulateKilowattHoursBy,
  operationalKilowattHours: number = kilowattHours,
): void => {
  setOrAccumulateByServiceAndUsageUnit(
    kilowattHoursByServiceAndUsageUnit,
    billingDataRow,
    kilowattHours,
    accumulateBy,
    operationalKilowattHours,
  )
  setOrAccumulateUsageUnitTotals(
    kilowattHoursByServiceAndUsageUnit,
    billingDataRow,
    kilowattHours,
    accumulateBy,
    operationalKilowattHours,
  )
}

/**
 * The operational energy in a running total. A total that has none recorded
 * holds no embodied emissions, so all of it is operational.
 */
export const operationalKilowattHoursOf = (
  totals: KilowattHourTotals,
): number => totals.operationalKilowattHours ?? totals.kilowattHours

/**
 * A new running total. The operational sum is recorded only when it differs
 * from the legacy total, so totals of usage with no embodied emissions keep
 * the shape they have always had.
 */
const newTotals = (
  accumulateBy: AccumulateKilowattHoursBy,
  accumValue: number,
  kilowattHours: number,
  operationalKilowattHours: number,
): KilowattHourTotals => ({
  [accumulateBy]: accumValue,
  kilowattHours: kilowattHours,
  ...(!Object.is(operationalKilowattHours, kilowattHours) && {
    operationalKilowattHours,
  }),
})

const addToTotals = (
  totals: KilowattHourTotals,
  accumulateBy: AccumulateKilowattHoursBy,
  accumValue: number,
  kilowattHours: number,
  operationalKilowattHours: number,
): void => {
  totals[accumulateBy] = (totals[accumulateBy] || 0) + accumValue
  // Before the legacy total grows: a total with no operational sum is read
  // as all operational.
  if (
    totals.operationalKilowattHours !== undefined ||
    !Object.is(operationalKilowattHours, kilowattHours)
  )
    totals.operationalKilowattHours =
      operationalKilowattHoursOf(totals) + operationalKilowattHours
  totals.kilowattHours += kilowattHours
}

const setOrAccumulateByServiceAndUsageUnit = (
  kilowattHoursByServiceAndUsageUnit: KilowattHoursByServiceAndUsageUnit,
  billingDataRow: BillingDataRow,
  kilowattHours: number,
  accumulateBy: AccumulateKilowattHoursBy,
  operationalKilowattHours: number,
): void => {
  const { serviceName, usageUnit, [accumulateBy]: accumValue } = billingDataRow

  // Service doesn't exist: set service and usage unit
  if (!kilowattHoursByServiceAndUsageUnit[serviceName]) {
    kilowattHoursByServiceAndUsageUnit[serviceName] = {
      [usageUnit]: newTotals(
        accumulateBy,
        accumValue,
        kilowattHours,
        operationalKilowattHours,
      ),
    }
    return
  }

  // Service exists, but no usage unit for the service: set usage unit for service
  if (
    kilowattHoursByServiceAndUsageUnit[serviceName] &&
    !kilowattHoursByServiceAndUsageUnit[serviceName][usageUnit]
  ) {
    kilowattHoursByServiceAndUsageUnit[serviceName][usageUnit] = newTotals(
      accumulateBy,
      accumValue,
      kilowattHours,
      operationalKilowattHours,
    )
    return
  }

  // Usage unit exists for service - accumulate
  if (kilowattHoursByServiceAndUsageUnit[serviceName][usageUnit]) {
    addToTotals(
      kilowattHoursByServiceAndUsageUnit[serviceName][usageUnit],
      accumulateBy,
      accumValue,
      kilowattHours,
      operationalKilowattHours,
    )
  }
}

const setOrAccumulateUsageUnitTotals = (
  kilowattHoursByServiceAndUsageUnit: KilowattHoursByServiceAndUsageUnit,
  billingDataRow: BillingDataRow,
  kilowattHours: number,
  accumulateBy: AccumulateKilowattHoursBy,
  operationalKilowattHours: number,
): void => {
  const { usageUnit, [accumulateBy]: accumValue } = billingDataRow
  if (kilowattHoursByServiceAndUsageUnit.total[usageUnit]) {
    addToTotals(
      kilowattHoursByServiceAndUsageUnit.total[usageUnit],
      accumulateBy,
      accumValue,
      kilowattHours,
      operationalKilowattHours,
    )
  } else {
    kilowattHoursByServiceAndUsageUnit.total[usageUnit] = newTotals(
      accumulateBy,
      accumValue,
      kilowattHours,
      operationalKilowattHours,
    )
  }
}

export const appendOrAccumulateEstimatesByDay = (
  results: MutableEstimationResult[],
  rowData: BillingDataRow,
  footprintEstimate: FootprintEstimate,
  grouping: GroupBy,
  tagNames: string[],
): void => {
  const serviceEstimate: MutableServiceEstimate = {
    cloudProvider: rowData.cloudProvider,
    kilowattHours: footprintEstimate.kilowattHours,
    co2e: footprintEstimate.co2e,
    usesAverageCPUConstant: !!footprintEstimate?.usesAverageCPUConstant,
    serviceName: rowData.serviceName,
    accountId: rowData.accountId,
    accountName: rowData.accountName,
    region: rowData.region,
    cost: rowData.cost,
    tags: rowData.tags,
    ...(footprintEstimate.provenance && {
      provenance: footprintEstimate.provenance,
    }),
    ...(hasEnergySplit(footprintEstimate) && {
      operationalKilowattHours: footprintEstimate.operationalKilowattHours,
      embodiedCo2e: footprintEstimate.embodiedCo2e,
    }),
  }

  const dayFoundInEstimate = results.find(
    (estimate) => estimate.timestamp.getTime() === rowData.timestamp.getTime(),
  )

  if (dayFoundInEstimate) {
    const estimateFoundWithSameRegionAndServiceAccountAndTags =
      dayFoundInEstimate.serviceEstimates.find((estimateForDay) => {
        return hasSameRegionAndServiceAndAccountAndTags(
          estimateForDay,
          serviceEstimate,
          tagNames,
        )
      })

    if (estimateFoundWithSameRegionAndServiceAccountAndTags) {
      // The merged row says how it splits only if every part does (ADR 0024).
      const bothSplit =
        hasEnergySplit(estimateFoundWithSameRegionAndServiceAccountAndTags) &&
        hasEnergySplit(serviceEstimate)
      // When the parts differ in provenance their intensities are blended.
      // Weighting by the electricity of each part keeps the identity of
      // ADR 0024 on the merged row; parts that do not say how they split
      // are weighted by the legacy total, as before.
      const provenance = mergeProvenance(
        estimateFoundWithSameRegionAndServiceAccountAndTags.provenance,
        bothSplit
          ? estimateFoundWithSameRegionAndServiceAccountAndTags.operationalKilowattHours
          : estimateFoundWithSameRegionAndServiceAccountAndTags.kilowattHours,
        serviceEstimate.provenance,
        bothSplit
          ? serviceEstimate.operationalKilowattHours
          : serviceEstimate.kilowattHours,
      )
      if (provenance)
        estimateFoundWithSameRegionAndServiceAccountAndTags.provenance =
          provenance

      if (bothSplit) {
        estimateFoundWithSameRegionAndServiceAccountAndTags.operationalKilowattHours +=
          serviceEstimate.operationalKilowattHours
        estimateFoundWithSameRegionAndServiceAccountAndTags.embodiedCo2e +=
          serviceEstimate.embodiedCo2e
      } else {
        delete estimateFoundWithSameRegionAndServiceAccountAndTags.operationalKilowattHours
        delete estimateFoundWithSameRegionAndServiceAccountAndTags.embodiedCo2e
      }

      estimateFoundWithSameRegionAndServiceAccountAndTags.kilowattHours +=
        serviceEstimate.kilowattHours

      estimateFoundWithSameRegionAndServiceAccountAndTags.co2e +=
        serviceEstimate.co2e

      estimateFoundWithSameRegionAndServiceAccountAndTags.cost +=
        serviceEstimate.cost

      if (serviceEstimate.usesAverageCPUConstant) {
        estimateFoundWithSameRegionAndServiceAccountAndTags.usesAverageCPUConstant =
          estimateFoundWithSameRegionAndServiceAccountAndTags.usesAverageCPUConstant ||
          serviceEstimate.usesAverageCPUConstant
      }
    } else {
      dayFoundInEstimate.serviceEstimates.push(serviceEstimate)
    }
  } else {
    results.push({
      timestamp: rowData.timestamp,
      periodStartDate: rowData.timestamp,
      periodEndDate: getPeriodEndDate(rowData.timestamp, grouping),
      groupBy: grouping,
      serviceEstimates: [serviceEstimate],
    })
  }
}

interface EnergySplit {
  operationalKilowattHours: number
  embodiedCo2e: number
}

/** Whether an estimate carries both fields of ADR 0024. */
const hasEnergySplit = <Estimate extends Partial<EnergySplit>>(
  estimate: Estimate,
): estimate is Estimate & EnergySplit =>
  estimate.operationalKilowattHours !== undefined &&
  estimate.embodiedCo2e !== undefined

function hasSameRegionAndServiceAndAccountAndTags(
  estimateOne: MutableServiceEstimate,
  estimateTwo: MutableServiceEstimate,
  tagNames: string[],
): boolean {
  if (
    estimateOne.region != estimateTwo.region ||
    estimateOne.serviceName != estimateTwo.serviceName ||
    estimateOne.accountId != estimateTwo.accountId
  ) {
    return false
  }

  for (const tagIndex in tagNames) {
    const tagName = tagNames[tagIndex]

    if (estimateOne.tags[tagName] != estimateTwo.tags[tagName]) {
      return false
    }
  }

  return true
}

// When we have a group of compute processor types, by we default calculate the average for this group of processors.
// However when the group contains either the Sandy Bridge or Ivy Bridge processor type, we calculate the median.
// This is because those processor types are outliers with much higher min/max watts that the other types, so we
// want to take this into account to not over estimate the compute energy in kilowatts.
export function getWattsByAverageOrMedian(
  computeProcessors: string[],
  wattsForProcessors: number[],
): number {
  if (
    computeProcessors.includes(COMPUTE_PROCESSOR_TYPES.SANDY_BRIDGE) ||
    computeProcessors.includes(COMPUTE_PROCESSOR_TYPES.IVY_BRIDGE)
  ) {
    return median(wattsForProcessors)
  }
  return getAverage(wattsForProcessors)
}

export function getAverage(nums: number[]): number {
  if (!nums.length) return 0
  if (nums.length === 1) return nums[0]
  return nums.reduce((a, b) => a + b) / nums.length
}

export function estimateCo2(
  estimatedKilowattHours: number,
  region: string,
  emissionsFactors: CloudConstantsEmissionsFactors,
): number {
  return (
    estimatedKilowattHours *
    (emissionsFactors[region] || emissionsFactors['Unknown'])
  )
}

export function estimateKwh(
  estimatedCo2e: number,
  region: string,
  emissionsFactors: CloudConstantsEmissionsFactors,
  replicationFactor = 1,
): number {
  const emissionsFactor =
    emissionsFactors[region] || emissionsFactors['Unknown']
  // Embodied emissions are counted as kWh at the grid factor. With no
  // non-zero factor (a zone at 0 gCO2e/kWh) there is no such conversion:
  // count no kWh rather than Infinity or NaN.
  if (!emissionsFactor) return 0
  return (estimatedCo2e / emissionsFactor) * replicationFactor
}
