/*
 * © 2021 Thoughtworks, Inc.
 */

import UnknownEstimator, { EstimateUnknownUsageBy } from '../UnknownEstimator'

describe('UnknownEstimator', () => {
  describe('Classification by service and usage unit', () => {
    it('does estimates for unknown usage type for AWS, based on cost', () => {
      const service = 'testService'
      const usageUnit = 'testUsageUnit'
      const input = [
        {
          timestamp: new Date('2021-01-01'),
          cost: 1000,
          usageUnit: usageUnit,
          service: service,
        },
      ]
      const awsUsEast1Region = 'us-east-1'
      const awsEmissionsFactors = {
        [awsUsEast1Region]: 0.000415755,
      }

      const awsConstants = {
        kilowattHoursByServiceAndUsageUnit: {
          [service]: {
            [usageUnit]: {
              cost: 50,
              kilowattHours: 20,
            },
          },
        },
      }
      const result = new UnknownEstimator(EstimateUnknownUsageBy.COST).estimate(
        input,
        awsUsEast1Region,
        awsEmissionsFactors,
        awsConstants,
      )

      expect(result).toEqual([
        {
          co2e: 0.166302,
          timestamp: new Date('2021-01-01T00:00:00.000Z'),
          kilowattHours: 400,
          usesAverageCPUConstant: false,
          operationalKilowattHours: 400,
          embodiedCo2e: 0,
        },
      ])
    })
    it('does estimates for unknown usage type for AWS, based on cost, using totals for that usage unit', () => {
      const service = 'testService'
      const usageUnit = 'testUsageUnit'
      const input = [
        {
          timestamp: new Date('2021-01-01'),
          cost: 1000,
          usageUnit: usageUnit,
          service: service,
        },
      ]
      const awsUsEast1Region = 'us-east-1'
      const awsEmissionsFactors = {
        [awsUsEast1Region]: 0.000415755,
      }

      const awsConstants = {
        kilowattHoursByServiceAndUsageUnit: {
          total: {
            [usageUnit]: {
              cost: 50,
              kilowattHours: 22,
            },
          },
        },
      }
      const result = new UnknownEstimator(EstimateUnknownUsageBy.COST).estimate(
        input,
        awsUsEast1Region,
        awsEmissionsFactors,
        awsConstants,
      )

      expect(result).toEqual([
        {
          co2e: 0.18293220000000002,
          timestamp: new Date('2021-01-01T00:00:00.000Z'),
          kilowattHours: 440,
          usesAverageCPUConstant: false,
          operationalKilowattHours: 440,
          embodiedCo2e: 0,
        },
      ])
    })
    it('does not estimate for unknown usage type for AWS, where usage unit is not in known usage', () => {
      const service = 'testService'
      const usageUnit = 'testUsageUnit'
      const input = [
        {
          timestamp: new Date('2021-01-01'),
          cost: 2000,
          usageUnit: usageUnit,
          service: service,
        },
      ]
      const awsUsEast1Region = 'us-east-1'
      const awsEmissionsFactors = {
        [awsUsEast1Region]: 0.000415755,
      }

      const awsConstants = {
        kilowattHoursByServiceAndUsageUnit: {
          total: {
            testUsageUnitTwo: {
              cost: 50,
              kilowattHours: 22,
            },
            testUsageUnitThree: {
              cost: 30,
              kilowattHours: 10,
            },
          },
        },
      }
      const result = new UnknownEstimator(EstimateUnknownUsageBy.COST).estimate(
        input,
        awsUsEast1Region,
        awsEmissionsFactors,
        awsConstants,
      )

      expect(result).toEqual([
        {
          co2e: 0,
          timestamp: new Date('2021-01-01T00:00:00.000Z'),
          kilowattHours: 0,
          usesAverageCPUConstant: false,
          operationalKilowattHours: 0,
          embodiedCo2e: 0,
        },
      ])
    })
  })

  describe('operational energy and embodied emissions (ADR 0024)', () => {
    const region = 'us-east-1'
    const factors = { [region]: 0.0004 }
    const usage = [
      {
        timestamp: new Date('2021-01-01'),
        cost: 1000,
        usageUnit: 'testUsageUnit',
        service: 'testService',
      },
    ]
    const estimateWith = (totals: {
      cost: number
      kilowattHours: number
      operationalKilowattHours?: number
    }) =>
      new UnknownEstimator(EstimateUnknownUsageBy.COST).estimate(
        usage,
        region,
        factors,
        {
          kilowattHoursByServiceAndUsageUnit: {
            testService: { testUsageUnit: totals },
          },
        },
      )[0]

    it('takes operational energy from the operational average and counts the rest of the emissions as embodied', () => {
      // Known usage: 50 of cost for 20 kWh in the legacy total, 15 kWh of it electricity.
      const estimate = estimateWith({
        cost: 50,
        kilowattHours: 20,
        operationalKilowattHours: 15,
      })
      expect(estimate.kilowattHours).toBe(400)
      expect(estimate.co2e).toBeCloseTo(0.16, 12)
      expect(estimate.operationalKilowattHours).toBe(300)
      expect(estimate.embodiedCo2e).toBeCloseTo(0.04, 12)
      expect(
        estimate.operationalKilowattHours * factors[region] +
          estimate.embodiedCo2e,
      ).toBeCloseTo(estimate.co2e, 12)
    })

    it('reads totals without an operational sum as all operational', () => {
      const estimate = estimateWith({ cost: 50, kilowattHours: 20 })
      expect(estimate.operationalKilowattHours).toBe(400)
      expect(estimate.embodiedCo2e).toBe(0)
    })

    it('has no embodied emissions at an intensity of 0, where the legacy estimate of unknown usage has no emissions at all', () => {
      const estimate = new UnknownEstimator(
        EstimateUnknownUsageBy.COST,
      ).estimate(
        usage,
        region,
        { [region]: 0, Unknown: 0 },
        {
          kilowattHoursByServiceAndUsageUnit: {
            testService: {
              testUsageUnit: {
                cost: 50,
                kilowattHours: 20,
                operationalKilowattHours: 15,
              },
            },
          },
        },
      )[0]
      expect(estimate.co2e).toBe(0)
      expect(estimate.operationalKilowattHours).toBe(300)
      expect(estimate.embodiedCo2e).toBe(0)
    })
  })
})
