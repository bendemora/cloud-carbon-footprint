/*
 * © 2021 Thoughtworks, Inc.
 */

import CloudConstants, {
  CloudConstantsEmissionsFactors,
} from '../CloudConstantsTypes'
import FootprintEstimate, {
  estimateCo2,
  KilowattHoursByServiceAndUsageUnit,
  KilowattHourTotals,
  operationalKilowattHoursOf,
} from '../FootprintEstimate'
import IFootprintEstimator from '../IFootprintEstimator'
import UnknownUsage from './UnknownUsage'

export enum EstimateUnknownUsageBy {
  COST = 'cost',
  USAGE_AMOUNT = 'usageAmount',
}

export default class UnknownEstimator implements IFootprintEstimator {
  constructor(private estimateKilowattHoursBy: EstimateUnknownUsageBy) {}

  estimate(
    data: UnknownUsage[],
    region: string,
    emissionsFactors: CloudConstantsEmissionsFactors,
    constants: CloudConstants,
  ): FootprintEstimate[] {
    return data.map((data: UnknownUsage) => {
      const totals = this.totalsFor(
        data,
        constants.kilowattHoursByServiceAndUsageUnit,
      )
      const estimatedKilowattHours = this.estimateKilowattHours(
        data,
        totals,
        (known) => known.kilowattHours,
      )
      const estimatedCo2eEmissions = estimateCo2(
        estimatedKilowattHours,
        region,
        emissionsFactors,
      )
      // ADR 0024: the operational energy comes from the average of
      // operational energy alone, and whatever else the legacy estimate
      // holds is embodied emissions inherited from the known rows.
      const operationalKilowattHours = this.estimateKilowattHours(
        data,
        totals,
        operationalKilowattHoursOf,
      )
      const estimate = {
        timestamp: data.timestamp,
        kilowattHours: estimatedKilowattHours,
        co2e: estimatedCo2eEmissions,
        usesAverageCPUConstant: false,
      }
      // A row with no co2e value has nothing to split (ADR 0024, point 4).
      if (!Number.isFinite(estimatedCo2eEmissions)) return estimate
      return {
        ...estimate,
        operationalKilowattHours,
        embodiedCo2e:
          estimatedCo2eEmissions -
          estimateCo2(operationalKilowattHours, region, emissionsFactors),
      }
    })
  }

  /** The running totals for the usage's service and unit, or for its unit. */
  private totalsFor(
    unknownUsage: UnknownUsage,
    kilowattHoursByServiceAndUsageUnit: KilowattHoursByServiceAndUsageUnit,
  ): KilowattHourTotals | undefined {
    return (
      kilowattHoursByServiceAndUsageUnit[unknownUsage.service]?.[
        unknownUsage.usageUnit
      ] || kilowattHoursByServiceAndUsageUnit.total[unknownUsage.usageUnit]
    )
  }

  private estimateKilowattHours(
    unknownUsage: UnknownUsage,
    totals: KilowattHourTotals | undefined,
    energyOf: (totals: KilowattHourTotals) => number,
  ): number {
    if (!totals) return 0
    return (
      (energyOf(totals) / totals[this.estimateKilowattHoursBy]) *
      unknownUsage[this.estimateKilowattHoursBy]
    )
  }
}
