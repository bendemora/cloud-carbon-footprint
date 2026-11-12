/*
 * © 2021 Thoughtworks, Inc.
 */

import FootprintEstimate, {
  accumulateKilowattHours,
  AccumulateKilowattHoursBy,
  aggregateEstimatesByDay,
  appendOrAccumulateEstimatesByDay,
  asOperationalEstimate,
  estimateCo2,
  estimateKwh,
  getWattsByAverageOrMedian,
  KilowattHoursByServiceAndUsageUnit,
  MutableEstimationResult,
  MutableServiceEstimate,
  operationalKilowattHoursOf,
} from '../FootprintEstimate'
import BillingDataRow from '../BillingDataRow'
import { COMPUTE_PROCESSOR_TYPES } from '../compute'
import { GroupBy } from '@cloud-carbon-footprint/common'
import each from 'jest-each'
import {
  accumulateKilowattHoursPerCostData,
  accumulateKilowattHoursPerUsageAmount,
} from './fixtures/footprintEstimate.fixtures'

describe('FootprintEstimate', () => {
  const dayOne = new Date('2021-01-01')
  const dayTwo = new Date('2021-01-02')
  const grouping = GroupBy.day

  it('aggregateEstimatesByDay', () => {
    // given
    const footprintEstimates: FootprintEstimate[] = [
      {
        timestamp: dayOne,
        kilowattHours: 20,
        co2e: 2,
        usesAverageCPUConstant: true,
      },
      {
        timestamp: dayOne,
        kilowattHours: 25,
        co2e: 4,
        usesAverageCPUConstant: false,
      },
      {
        timestamp: dayOne,
        kilowattHours: 40,
        co2e: 10,
        usesAverageCPUConstant: true,
      },
      {
        timestamp: dayTwo,
        kilowattHours: 15,
        co2e: 0.3,
        usesAverageCPUConstant: false,
      },
      {
        timestamp: dayTwo,
        kilowattHours: 60,
        co2e: 7,
        usesAverageCPUConstant: false,
      },
    ]
    // when
    const result = aggregateEstimatesByDay(footprintEstimates)

    // then
    const expectedResult = {
      '2021-01-01': {
        co2e: 16,
        kilowattHours: 85,
        timestamp: dayOne,
        usesAverageCPUConstant: true,
      },
      '2021-01-02': {
        co2e: 7.3,
        kilowattHours: 75,
        timestamp: dayTwo,
        usesAverageCPUConstant: false,
      },
    }
    expect(result).toEqual(expectedResult)
  })

  it('appendOrAccumulateEstimatesByDay', () => {
    const tagNames = ['Environment']

    // given - accumulate
    const results = [
      {
        timestamp: dayOne,
        serviceEstimates: [
          {
            cloudProvider: 'GCP',
            kilowattHours: 0.00512128634808404,
            co2e: 0.00000256064317404202,
            usesAverageCPUConstant: false,
            serviceName: 'App Engine',
            accountId: 'test account id',
            accountName: 'test-account',
            region: 'us-east1',
            cost: 5,
            tags: {
              Environment: 'prod',
            },
          },
        ],
        periodStartDate: dayOne,
        periodEndDate: new Date('2021-01-01T23:59:59.000Z'),
        groupBy: GroupBy.day,
      },
    ]

    const billingDataRowOne: BillingDataRow = {
      timestamp: dayOne,
      accountId: 'test account id',
      accountName: 'test-account',
      region: 'us-east1',
      usageType: 'test',
      usageUnit: 'test',
      vCpus: undefined,
      machineType: 'test',
      seriesName: 'test',
      serviceName: 'App Engine',
      usageAmount: 380040914534400,
      cost: 10,
      cloudProvider: 'GCP',
      vCpuHours: 105566920704,
      instanceType: 'test',
      replicationFactor: 1,
      tags: {
        Environment: 'prod',
      },
    }

    const footPrintEstimateOne: FootprintEstimate = {
      usesAverageCPUConstant: false,
      timestamp: dayOne,
      kilowattHours: 0.00006877379319146276,
      co2e: 3.438689659573138e-8,
    }

    // when - accumulate
    appendOrAccumulateEstimatesByDay(
      results,
      billingDataRowOne,
      footPrintEstimateOne,
      grouping,
      tagNames,
    )

    // then - accumulate
    const accumulatedServicesEstimate: MutableServiceEstimate = {
      accountId: 'test account id',
      accountName: 'test-account',
      cloudProvider: 'GCP',
      co2e: 0.000002595030070637751,
      cost: 15,
      kilowattHours: 0.005190060141275502,
      region: 'us-east1',
      serviceName: 'App Engine',
      usesAverageCPUConstant: false,
      tags: {
        Environment: 'prod',
      },
    }
    const newResultOne = [
      {
        timestamp: dayOne,
        periodStartDate: new Date('2021-01-01T00:00:00.000Z'),
        periodEndDate: new Date('2021-01-01T23:59:59.000Z'),
        groupBy: grouping,
        serviceEstimates: [accumulatedServicesEstimate],
      },
    ]
    expect(results).toEqual(newResultOne)

    // given - append
    const billingDataRowTwo: BillingDataRow = {
      timestamp: dayTwo,
      accountId: 'test account id',
      accountName: 'test-account',
      region: 'us-east1',
      serviceName: 'App Engine',
      usageType: 'test',
      usageUnit: 'test',
      vCpus: undefined,
      machineType: 'test',
      seriesName: 'test',
      usageAmount: 380040914534400,
      cost: 10,
      cloudProvider: 'GCP',
      vCpuHours: 105566920704,
      instanceType: 'test',
      replicationFactor: 1,
      tags: {
        Environment: 'prod',
      },
    }

    const footPrintEstimateTwo: FootprintEstimate = {
      usesAverageCPUConstant: false,
      timestamp: dayTwo,
      kilowattHours: 0.00006877379319146276,
      co2e: 3.438689659573138e-8,
    }
    // when - accumulate
    appendOrAccumulateEstimatesByDay(
      results,
      billingDataRowTwo,
      footPrintEstimateTwo,
      grouping,
      tagNames,
    )
    // then - append
    const newResultTwo = [
      {
        timestamp: dayOne,
        serviceEstimates: [accumulatedServicesEstimate],
        groupBy: grouping,
        periodEndDate: new Date('2021-01-01T23:59:59.000Z'),
        periodStartDate: new Date('2021-01-01T00:00:00.000Z'),
      },
      {
        timestamp: dayTwo,
        serviceEstimates: [
          {
            cloudProvider: 'GCP',
            usesAverageCPUConstant: false,
            serviceName: 'App Engine',
            accountId: 'test account id',
            accountName: 'test-account',
            region: 'us-east1',
            co2e: 3.438689659573138e-8,
            cost: 10,
            kilowattHours: 0.00006877379319146276,
            tags: {
              Environment: 'prod',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2021-01-02T23:59:59.000Z'),
        periodStartDate: new Date('2021-01-02T00:00:00.000Z'),
      },
    ]
    expect(results).toEqual(newResultTwo)

    // given - append
    const billingDataRowThree: BillingDataRow = {
      timestamp: dayTwo,
      accountId: 'test account id 2',
      accountName: 'test-account',
      region: 'us-east1',
      serviceName: 'App Engine',
      usageType: 'test',
      usageUnit: 'test',
      vCpus: undefined,
      machineType: 'test',
      seriesName: 'test',
      usageAmount: 380040914534400,
      cost: 10,
      cloudProvider: 'GCP',
      vCpuHours: 105566920704,
      instanceType: 'test',
      replicationFactor: 1,
      tags: {
        Environment: 'prod',
      },
    }

    const footPrintEstimateThree: FootprintEstimate = {
      usesAverageCPUConstant: false,
      timestamp: dayTwo,
      kilowattHours: 0.00006877379319146276,
      co2e: 3.438689659573138e-8,
    }
    // when - accumulate
    appendOrAccumulateEstimatesByDay(
      results,
      billingDataRowThree,
      footPrintEstimateThree,
      grouping,
      tagNames,
    )
    // then - append
    const newResultThree = [
      {
        timestamp: dayOne,
        serviceEstimates: [accumulatedServicesEstimate],
        groupBy: grouping,
        periodEndDate: new Date('2021-01-01T23:59:59.000Z'),
        periodStartDate: new Date('2021-01-01T00:00:00.000Z'),
      },
      {
        timestamp: dayTwo,
        serviceEstimates: [
          {
            cloudProvider: 'GCP',
            usesAverageCPUConstant: false,
            serviceName: 'App Engine',
            accountId: 'test account id',
            accountName: 'test-account',
            region: 'us-east1',
            co2e: 3.438689659573138e-8,
            cost: 10,
            kilowattHours: 0.00006877379319146276,
            tags: {
              Environment: 'prod',
            },
          },
          {
            cloudProvider: 'GCP',
            usesAverageCPUConstant: false,
            serviceName: 'App Engine',
            accountId: 'test account id 2',
            accountName: 'test-account',
            region: 'us-east1',
            co2e: 3.438689659573138e-8,
            cost: 10,
            kilowattHours: 0.00006877379319146276,
            tags: {
              Environment: 'prod',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2021-01-02T23:59:59.000Z'),
        periodStartDate: new Date('2021-01-02T00:00:00.000Z'),
      },
    ]
    expect(results).toEqual(newResultThree)

    // given - append
    const billingDataRowFour: BillingDataRow = {
      timestamp: dayTwo,
      accountId: 'test account id 2',
      accountName: 'test-account',
      region: 'us-east1',
      serviceName: 'App Engine',
      usageType: 'test',
      usageUnit: 'test',
      vCpus: undefined,
      machineType: 'test',
      seriesName: 'test',
      usageAmount: 380040914534400,
      cost: 10,
      cloudProvider: 'GCP',
      vCpuHours: 105566920704,
      instanceType: 'test',
      replicationFactor: 1,
      tags: {
        Environment: 'staging',
      },
    }

    const footPrintEstimateFour: FootprintEstimate = {
      usesAverageCPUConstant: false,
      timestamp: dayTwo,
      kilowattHours: 0.00006877379319146276,
      co2e: 3.438689659573138e-8,
    }
    // when - accumulate
    appendOrAccumulateEstimatesByDay(
      results,
      billingDataRowFour,
      footPrintEstimateFour,
      grouping,
      tagNames,
    )
    // then - append
    const newResultFour = [
      {
        timestamp: dayOne,
        serviceEstimates: [accumulatedServicesEstimate],
        groupBy: grouping,
        periodEndDate: new Date('2021-01-01T23:59:59.000Z'),
        periodStartDate: new Date('2021-01-01T00:00:00.000Z'),
      },
      {
        timestamp: dayTwo,
        serviceEstimates: [
          {
            cloudProvider: 'GCP',
            usesAverageCPUConstant: false,
            serviceName: 'App Engine',
            accountId: 'test account id',
            accountName: 'test-account',
            region: 'us-east1',
            co2e: 3.438689659573138e-8,
            cost: 10,
            kilowattHours: 0.00006877379319146276,
            tags: {
              Environment: 'prod',
            },
          },
          {
            cloudProvider: 'GCP',
            usesAverageCPUConstant: false,
            serviceName: 'App Engine',
            accountId: 'test account id 2',
            accountName: 'test-account',
            region: 'us-east1',
            co2e: 3.438689659573138e-8,
            cost: 10,
            kilowattHours: 0.00006877379319146276,
            tags: {
              Environment: 'prod',
            },
          },
          {
            cloudProvider: 'GCP',
            usesAverageCPUConstant: false,
            serviceName: 'App Engine',
            accountId: 'test account id 2',
            accountName: 'test-account',
            region: 'us-east1',
            co2e: 3.438689659573138e-8,
            cost: 10,
            kilowattHours: 0.00006877379319146276,
            tags: {
              Environment: 'staging',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2021-01-02T23:59:59.000Z'),
        periodStartDate: new Date('2021-01-02T00:00:00.000Z'),
      },
    ]
    expect(results).toEqual(newResultFour)
  })

  describe('accumulateKilowattHours by cost', () => {
    each(accumulateKilowattHoursPerCostData).it(
      'kilowatt hours and cost totals per service and usage unit',
      (
        kilowattHoursByServiceAndUsageUnit,
        billingDataRow,
        kilowattHours,
        expectedResult,
      ) => {
        accumulateKilowattHours(
          kilowattHoursByServiceAndUsageUnit,
          billingDataRow,
          kilowattHours,
          AccumulateKilowattHoursBy.COST,
        )
        expect(kilowattHoursByServiceAndUsageUnit).toEqual(expectedResult)
      },
    )
  })

  describe('accumulateKilowattHours by usage amount', () => {
    each(accumulateKilowattHoursPerUsageAmount).it(
      'kilowatt hours and cost totals per service and usage unit',
      (
        kilowattHoursByServiceAndUsageUnit,
        billingDataRow,
        kilowattHours,
        expectedResult,
      ) => {
        accumulateKilowattHours(
          kilowattHoursByServiceAndUsageUnit,
          billingDataRow,
          kilowattHours,
          AccumulateKilowattHoursBy.USAGE_AMOUNT,
        )
        expect(kilowattHoursByServiceAndUsageUnit).toEqual(expectedResult)
      },
    )
  })

  describe('operational energy and embodied emissions (ADR 0024)', () => {
    const row = (overrides: Partial<BillingDataRow> = {}): BillingDataRow =>
      ({
        timestamp: dayOne,
        accountId: 'test account id',
        accountName: 'test-account',
        region: 'us-east-1',
        usageType: 'test',
        usageUnit: 'Hrs',
        serviceName: 'AmazonEC2',
        usageAmount: 2,
        cost: 5,
        cloudProvider: 'AWS',
        tags: {},
        ...overrides,
      }) as BillingDataRow

    describe('asOperationalEstimate', () => {
      it('counts all the energy of an estimate as electricity and none of its emissions as embodied', () => {
        expect(
          asOperationalEstimate({
            timestamp: dayOne,
            kilowattHours: 20,
            co2e: 0.008,
            usesAverageCPUConstant: true,
          }),
        ).toEqual({
          timestamp: dayOne,
          kilowattHours: 20,
          co2e: 0.008,
          usesAverageCPUConstant: true,
          operationalKilowattHours: 20,
          embodiedCo2e: 0,
        })
      })

      it('leaves an estimate that already says how it splits as it is', () => {
        const estimate = {
          timestamp: dayOne,
          kilowattHours: 25,
          co2e: 0.01,
          operationalKilowattHours: 20,
          embodiedCo2e: 0.002,
        }
        expect(asOperationalEstimate(estimate)).toBe(estimate)
      })

      it('leaves an estimate with no co2e value without the two fields', () => {
        const estimate = { timestamp: dayOne, kilowattHours: 0, co2e: NaN }
        expect(asOperationalEstimate(estimate)).toBe(estimate)
      })
    })

    describe('accumulateKilowattHours', () => {
      const accumulate = (
        totals: KilowattHoursByServiceAndUsageUnit,
        kilowattHours: number,
        operationalKilowattHours?: number,
      ) =>
        accumulateKilowattHours(
          totals,
          row(),
          kilowattHours,
          AccumulateKilowattHoursBy.COST,
          operationalKilowattHours,
        )

      it('records no operational sum while every row is all electricity, so the totals keep their shape', () => {
        const totals: KilowattHoursByServiceAndUsageUnit = { total: {} }
        accumulate(totals, 20)
        accumulate(totals, 10)
        expect(totals).toEqual({
          AmazonEC2: { Hrs: { cost: 10, kilowattHours: 30 } },
          total: { Hrs: { cost: 10, kilowattHours: 30 } },
        })
        expect(operationalKilowattHoursOf(totals.total.Hrs)).toBe(30)
      })

      it('records the operational sum from the first row with embodied emissions in its total, counting earlier rows as all electricity', () => {
        const totals: KilowattHoursByServiceAndUsageUnit = { total: {} }
        accumulate(totals, 20)
        accumulate(totals, 30, 24)
        accumulate(totals, 10)
        const expected = {
          cost: 15,
          kilowattHours: 60,
          operationalKilowattHours: 54,
        }
        expect(totals).toEqual({
          AmazonEC2: { Hrs: expected },
          total: { Hrs: expected },
        })
        expect(operationalKilowattHoursOf(totals.total.Hrs)).toBe(54)
      })

      it('records the operational sum of a first row with embodied emissions', () => {
        const totals: KilowattHoursByServiceAndUsageUnit = { total: {} }
        accumulate(totals, 30, 24)
        expect(totals.AmazonEC2.Hrs).toEqual({
          cost: 5,
          kilowattHours: 30,
          operationalKilowattHours: 24,
        })
        expect(totals.total.Hrs).toEqual(totals.AmazonEC2.Hrs)
      })
    })

    describe('appendOrAccumulateEstimatesByDay', () => {
      const split = {
        timestamp: dayOne,
        kilowattHours: 25,
        co2e: 0.01,
        operationalKilowattHours: 20,
        embodiedCo2e: 0.002,
      }
      const noSplit = { timestamp: dayOne, kilowattHours: 0, co2e: NaN }
      const merged = (estimates: FootprintEstimate[]) => {
        const results: MutableEstimationResult[] = []
        for (const estimate of estimates)
          appendOrAccumulateEstimatesByDay(
            results,
            row(),
            estimate,
            grouping,
            [],
          )
        expect(results).toHaveLength(1)
        expect(results[0].serviceEstimates).toHaveLength(1)
        return results[0].serviceEstimates[0]
      }

      it('carries the two fields onto the service estimate', () => {
        expect(merged([split])).toMatchObject({
          kilowattHours: 25,
          co2e: 0.01,
          operationalKilowattHours: 20,
          embodiedCo2e: 0.002,
        })
      })

      it('sums them when rows accumulate into one service estimate', () => {
        const estimate = merged([
          split,
          split,
          asOperationalEstimate({
            timestamp: dayOne,
            kilowattHours: 25,
            co2e: 0.01,
          }),
        ])
        expect(estimate.kilowattHours).toBe(75)
        expect(estimate.operationalKilowattHours).toBe(65)
        expect(estimate.embodiedCo2e).toBeCloseTo(0.004, 15)
      })

      it('gives a service estimate neither field when a row without them is part of it, whatever the order', () => {
        for (const estimates of [
          [split, noSplit, split],
          [noSplit, split, split],
          [split, split, noSplit],
        ]) {
          const estimate = merged(estimates)
          expect(estimate).not.toHaveProperty('operationalKilowattHours')
          expect(estimate).not.toHaveProperty('embodiedCo2e')
        }
      })

      it('gives a service estimate neither field when its rows never had them', () => {
        const estimate = merged([
          { timestamp: dayOne, kilowattHours: 5, co2e: 0.002 },
          { timestamp: dayOne, kilowattHours: 5, co2e: 0.002 },
        ])
        expect(estimate.kilowattHours).toBe(10)
        expect(estimate).not.toHaveProperty('operationalKilowattHours')
        expect(estimate).not.toHaveProperty('embodiedCo2e')
      })
    })
  })

  describe('getWattsByAverageOrMedian', () => {
    it('returns median', () => {
      // given
      const computeProcessors: string[] = [COMPUTE_PROCESSOR_TYPES.SANDY_BRIDGE]
      const wattsForProcessors: number[] = [1, 2, 3, 4, 5]
      // when

      const result = getWattsByAverageOrMedian(
        computeProcessors,
        wattsForProcessors,
      )

      // then
      expect(result).toEqual(3)
    })
    it('returns 0 with no wattsForProcessors', () => {
      // given
      const computeProcessors: string[] = [COMPUTE_PROCESSOR_TYPES.CASCADE_LAKE]
      const wattsForProcessors: number[] = []
      // when

      const result = getWattsByAverageOrMedian(
        computeProcessors,
        wattsForProcessors,
      )

      // then
      expect(result).toEqual(0)
    })
    it('returns first watts with 1 wattsForProcessors', () => {
      // given
      const computeProcessors: string[] = [COMPUTE_PROCESSOR_TYPES.CASCADE_LAKE]
      const wattsForProcessors: number[] = [5]
      // when

      const result = getWattsByAverageOrMedian(
        computeProcessors,
        wattsForProcessors,
      )

      // then
      expect(result).toEqual(5)
    })
    it('returns mean watts with >1 wattsForProcessors', () => {
      // given
      const computeProcessors: string[] = [COMPUTE_PROCESSOR_TYPES.CASCADE_LAKE]
      const wattsForProcessors: number[] = [5, 7, 1, 4, 12, 20]
      // when

      const result = getWattsByAverageOrMedian(
        computeProcessors,
        wattsForProcessors,
      )

      // then
      expect(result).toEqual(8.166666666666666)
    })
  })

  describe('estimateCo2', () => {
    const emissionsFactors = {
      testRegion: 2,
      Unknown: 3,
    }
    it('estimates CO2e for known region', () => {
      const result = estimateCo2(2, 'testRegion', emissionsFactors)
      expect(result).toEqual(4)
    })

    it('estimates CO2e for unknown region', () => {
      const result = estimateCo2(2, 'someRegion', emissionsFactors)
      expect(result).toEqual(6)
    })

    it('estimates 0 when the region and Unknown factors are both 0', () => {
      expect(estimateCo2(2, 'zero', { zero: 0, Unknown: 0 })).toEqual(0)
    })
  })

  describe('estimateKwh', () => {
    it('converts CO2e to kWh at the region factor, times the replication factor', () => {
      expect(estimateKwh(4, 'testRegion', { testRegion: 2 }, 3)).toEqual(6)
    })

    it('converts at the Unknown factor for an unknown region', () => {
      expect(estimateKwh(6, 'someRegion', { Unknown: 3 })).toEqual(2)
    })

    it('gives 0 kWh, not Infinity or NaN, when there is no non-zero factor', () => {
      expect(estimateKwh(4, 'zero', { zero: 0, Unknown: 0 })).toEqual(0)
      expect(estimateKwh(4, 'missing', {})).toEqual(0)
    })
  })
})
