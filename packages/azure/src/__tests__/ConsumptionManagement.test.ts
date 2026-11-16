/*
 * © 2021 Thoughtworks, Inc.
 */

import { ConsumptionManagementClient } from '@azure/arm-consumption'

import {
  CCFConfig,
  EstimationResult,
  ServiceData,
  GroupBy,
  LookupTableInput,
  LookupTableOutput,
  setConfig,
} from '@cloud-carbon-footprint/common'
import {
  ComputeEstimator,
  EmbodiedEmissionsEstimator,
  MemoryEstimator,
  NetworkingEstimator,
  StorageEstimator,
  UnknownEstimator,
} from '@cloud-carbon-footprint/core'

import {
  mockConsumptionManagementResponseEight,
  mockConsumptionManagementResponseEleven,
  mockConsumptionManagementResponseFive,
  mockConsumptionManagementResponseFour,
  mockConsumptionManagementResponseNine,
  mockConsumptionManagementResponseOne,
  mockConsumptionManagementResponseSeven,
  mockConsumptionManagementResponseSix,
  mockConsumptionManagementResponseTen,
  mockConsumptionManagementResponseThree,
  mockConsumptionManagementResponseTwo,
  mockIterableResponse,
} from './fixtures/consumptionManagement.fixtures'

import { ConsumptionManagementService } from '../lib'
import { UsageDetailResult } from '../lib/ConsumptionTypes'
import {
  AZURE_CLOUD_CONSTANTS,
  AZURE_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
} from '../domain'
import { tonnesToGrams } from '@cloud-carbon-footprint/grid-intensity'

const mockUsageDetails = { list: jest.fn() }

// Records the grid intensity calls and delegates to the real adapter.
const mockResolveCalls: unknown[][] = []
// When set, returned instead of the real resolution (a live source stand-in).
let mockResolveOverride: unknown
jest.mock('@cloud-carbon-footprint/grid-intensity', () => {
  const actual = jest.requireActual('@cloud-carbon-footprint/grid-intensity')
  return {
    ...actual,
    resolveEmissionsFactors: (...args: unknown[]) => {
      mockResolveCalls.push(args)
      return mockResolveOverride
        ? Promise.resolve(mockResolveOverride)
        : actual.resolveEmissionsFactors(...args)
    },
  }
})

/**
 * ADR 0024: a row with a co2e value says how much of its energy is
 * electricity and how much of its emissions is embodied, and its co2e is the
 * electricity at the row's grid intensity plus the embodied emissions.
 */
const expectEnergySplit = (estimate: ServiceData) => {
  const { operationalKilowattHours, embodiedCo2e, co2e, provenance } = estimate
  expect(operationalKilowattHours).toBeGreaterThanOrEqual(0)
  expect(embodiedCo2e).toBeGreaterThanOrEqual(-1e-15)
  const rebuilt =
    (operationalKilowattHours * provenance.gCO2ePerKWh) / 1e6 + embodiedCo2e
  expect(Math.abs(rebuilt - co2e)).toBeLessThanOrEqual(
    1e-9 * Math.abs(co2e) + 1e-18,
  )
}

/**
 * The results without provenance and without the two fields of ADR 0024,
 * for comparing with expectations written before those existed. Fails if any
 * service estimate lacks provenance, or does not split as ADR 0024 says, so
 * stripping cannot hide a missing or wrong field.
 */
const withoutProvenance = (results: EstimationResult[]) =>
  results.map((result) => ({
    ...result,
    serviceEstimates: result.serviceEstimates.map((serviceEstimate) => {
      const {
        provenance,
        operationalKilowattHours: _operationalKilowattHours,
        embodiedCo2e: _embodiedCo2e,
        ...estimate
      } = serviceEstimate
      expect(provenance?.qualityTier).toEqual(expect.any(String))
      expectEnergySplit(serviceEstimate)
      return estimate
    }),
  }))

jest.mock('@cloud-carbon-footprint/common', () => ({
  ...(jest.requireActual('@cloud-carbon-footprint/common') as Record<
    string,
    unknown
  >),
}))

jest.mock('@azure/arm-consumption', () => {
  return {
    ConsumptionManagementClient: jest
      .fn()
      .mockImplementation((_, subscriptionId: string) => {
        return {
          usageDetails: mockUsageDetails,
          subscriptionId: subscriptionId,
        }
      }),
  }
})

const DEFAULT_CONFIG: CCFConfig = {
  AZURE: {
    RESOURCE_TAG_NAMES: ['resourceGroup', 'custom', 'created-by', 'other'],
  },
}

describe('Azure Consumption Management Service', () => {
  const startDate = new Date('2020-11-02')
  const endDate = new Date('2020-11-07')
  const grouping: GroupBy = GroupBy.day
  const subscriptionId = 'test-subscription-id'
  const subscriptionName = 'test-subscription'
  const mockCredentials = {
    msalFlow: jest.fn(),
    getToken: jest.fn(),
  }

  beforeEach(() => {
    AZURE_CLOUD_CONSTANTS.KILOWATT_HOURS_BY_SERVICE_AND_USAGE_UNIT = {
      total: {},
    }

    setConfig(DEFAULT_CONFIG)
  })

  it('Returns estimates for Compute', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseOne),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-02'),
        serviceEstimates: [
          {
            kilowattHours: 0.2614738305048199,
            co2e: 0.00005883161186358448,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Virtual Machines',
            cost: 5,
            region: 'uksouth',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.002863085156621724,
            co2e: 9.402371654345742e-7, // Very very small decimal
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Virtual Machines',
            cost: 10,
            region: 'westeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.07270161248463072,
            co2e: 0.0000284257222161796,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Azure App Service',
            cost: 10,
            region: 'CentralUS',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-02T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-02T00:00:00.000Z'),
      },
      {
        timestamp: new Date('2020-11-03'),
        serviceEstimates: [
          {
            kilowattHours: 0.025359,
            co2e: 0.000008473886427252899,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Container Instances',
            cost: 12,
            region: 'SouthCentralUS',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.18258479999999996,
            co2e: 0.00006413838151448518,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Azure Database for MySQL',
            cost: 12,
            region: 'Unknown',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: 'test-subscription-id',
            accountName: 'test-subscription',
            cloudProvider: 'AZURE',
            co2e: 0.00004108157999999999,
            cost: 12,
            kilowattHours: 0.18258479999999996,
            region: 'ukwest',
            serviceName: 'Virtual Machines Licenses',
            usesAverageCPUConstant: false,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: 'test-subscription-id',
            accountName: 'test-subscription',
            cloudProvider: 'AZURE',
            co2e: 0.00006413838151448518,
            cost: 12,
            kilowattHours: 0.18258479999999996,
            region: 'Unknown',
            serviceName: 'VPN Gateway',
            usesAverageCPUConstant: false,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-03T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-03T00:00:00.000Z'),
      },
    ]
    expect(withoutProvenance(result)).toEqual(expectedResult)
  })

  it("resolves grid intensity over each usage row's period with the Azure table", async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseOne),
    )
    mockResolveCalls.length = 0

    await new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    ).getEstimates(startDate, endDate, grouping)

    expect(mockResolveCalls.length).toBeGreaterThan(0)
    for (const call of mockResolveCalls) {
      // provider, region, period start, period end and the static table
      expect(call).toHaveLength(5)
      const [provider, region, start, end, table] = call as [
        string,
        string,
        Date,
        Date,
        unknown,
      ]
      expect(provider).toBe('AZURE')
      expect(region).toEqual(expect.any(String))
      // a day grouping: one whole day from the row's timestamp, exclusive end
      expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000)
      expect(table).toEqual({
        factors: AZURE_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
      })
    }
  })

  describe('operational energy and embodied emissions (ADR 0024)', () => {
    const liveProvenance = (gCO2ePerKWh: number) => ({
      sourceId: 'live-source',
      zoneId: 'TEST',
      granularity: 'hour',
      basis: 'location-consumption',
      factorType: 'lifecycle',
      isEstimated: false,
      licenceId: 'public-domain',
      qualityTier: 'B',
      gCO2ePerKWh,
      modelVersion: 'unversioned',
    })

    /** Every service estimate of a fresh run over the fixture. */
    const estimatesFor = async (fixture: UsageDetailResult[]) => {
      AZURE_CLOUD_CONSTANTS.KILOWATT_HOURS_BY_SERVICE_AND_USAGE_UNIT = {
        total: {},
      }
      mockUsageDetails.list.mockReturnValue(mockIterableResponse(fixture))
      const results = await new ConsumptionManagementService(
        new ComputeEstimator(),
        new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
        new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
        new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
        new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
        new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
        new EmbodiedEmissionsEstimator(
          AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
        ),
        new ConsumptionManagementClient(mockCredentials, subscriptionId),
      ).getEstimates(startDate, endDate, grouping)
      return results.flatMap((result) => result.serviceEstimates)
    }

    afterEach(() => {
      mockResolveOverride = undefined
    })

    it('separates the embodied emissions of compute rows from their electricity, and gives other rows none', async () => {
      const estimates = await estimatesFor(
        mockConsumptionManagementResponseNine,
      )
      estimates.forEach(expectEnergySplit)
      const withEmbodied = estimates.filter(
        (estimate) => estimate.embodiedCo2e > 0,
      )
      expect(withEmbodied.length).toBeGreaterThan(0)
      for (const estimate of withEmbodied)
        expect(estimate.operationalKilowattHours).toBeLessThan(
          estimate.kilowattHours,
        )

      // No row of this fixture is compute: it is storage, and one row of
      // unknown usage estimated from the storage average.
      const storageOnly = await estimatesFor(
        mockConsumptionManagementResponseTwo,
      )
      storageOnly.forEach(expectEnergySplit)
      expect(storageOnly.length).toBeGreaterThan(0)
      for (const estimate of storageOnly) {
        expect(estimate.embodiedCo2e).toBe(0)
        expect(estimate.operationalKilowattHours).toBe(estimate.kilowattHours)
      }
    })

    it.each([
      ['with embodied emissions', mockConsumptionManagementResponseNine],
      ['with unknown usage', mockConsumptionManagementResponseEight],
    ])(
      'reports the same electricity and embodied emissions at 400 and at 50 gCO2e/kWh when every row is resolved at the same intensity, for usage %s',
      async (_name, fixture) => {
        mockResolveOverride = {
          factors: { Unknown: 0.0004 },
          provenance: liveProvenance(400),
        }
        const dirtyGrid = await estimatesFor(fixture)
        mockResolveOverride = {
          factors: { Unknown: 0.00005 },
          provenance: liveProvenance(50),
        }
        const cleanGrid = await estimatesFor(fixture)

        expect(cleanGrid.length).toBe(dirtyGrid.length)
        expect(cleanGrid.length).toBeGreaterThan(0)
        cleanGrid.forEach((clean, index) => {
          const dirty = dirtyGrid[index]
          expectEnergySplit(clean)
          expectEnergySplit(dirty)
          expect(clean.operationalKilowattHours).toBeCloseTo(
            dirty.operationalKilowattHours,
            9,
          )
          expect(clean.embodiedCo2e).toBeCloseTo(dirty.embodiedCo2e, 12)
          // The legacy total grows on the cleaner grid wherever there are
          // embodied emissions: they become more kilowatt hours.
          if (clean.embodiedCo2e > 1e-12)
            expect(clean.kilowattHours).toBeGreaterThan(dirty.kilowattHours)
        })
      },
    )

    it('reports the embodied emissions that unknown usage inherits from the known usage it is averaged from', async () => {
      // A virtual machine with embodied emissions, and a service CCF has no
      // model for that is billed in the same unit, so it is estimated from
      // the machine's average.
      const usage = (
        meterName: string,
        meterCategory: string,
        quantity: number,
      ) =>
        ({
          id: 'test-subscription-id',
          kind: 'legacy',
          name: 'name',
          type: 'type',
          tags: {},
          date: new Date('2020-11-02'),
          quantity,
          cost: 10,
          meterDetails: {
            meterName,
            unitOfMeasure: '1 Hour',
            meterCategory,
          },
          subscriptionName: 'test-subscription',
          resourceLocation: 'northeurope',
          resourceGroup: 'test-resource-group',
        }) as unknown as UsageDetailResult
      const fixture = [
        usage('D8 v3', 'Virtual Machines', 5),
        usage('Standard Gateway', 'Azure Bastion', 7),
      ]
      const unknownRow = (estimates: ServiceData[]) =>
        estimates.find((estimate) => estimate.serviceName === 'Azure Bastion')

      mockResolveOverride = {
        factors: { Unknown: 0.0004 },
        provenance: liveProvenance(400),
      }
      const dirtyGrid = await estimatesFor(fixture)
      mockResolveOverride = {
        factors: { Unknown: 0.00005 },
        provenance: liveProvenance(50),
      }
      const cleanGrid = await estimatesFor(fixture)

      dirtyGrid.forEach(expectEnergySplit)
      cleanGrid.forEach(expectEnergySplit)
      const dirty = unknownRow(dirtyGrid)
      const clean = unknownRow(cleanGrid)
      expect(dirty.embodiedCo2e).toBeGreaterThan(0)
      expect(dirty.operationalKilowattHours).toBeGreaterThan(0)
      expect(dirty.operationalKilowattHours).toBeLessThan(dirty.kilowattHours)
      expect(clean.operationalKilowattHours).toBeCloseTo(
        dirty.operationalKilowattHours,
        12,
      )
      expect(clean.embodiedCo2e).toBeCloseTo(dirty.embodiedCo2e, 15)
    })

    it('holds at an intensity of 0, where co2e is the embodied emissions alone', async () => {
      mockResolveOverride = {
        factors: { Unknown: 0 },
        provenance: liveProvenance(0),
      }
      const estimates = await estimatesFor(
        mockConsumptionManagementResponseNine,
      )
      estimates.forEach(expectEnergySplit)
      expect(estimates.some((estimate) => estimate.embodiedCo2e > 0)).toBe(true)
      for (const estimate of estimates) {
        expect(estimate.co2e).toBe(estimate.embodiedCo2e)
        expect(estimate.operationalKilowattHours).toBe(estimate.kilowattHours)
      }
    })
  })

  describe('provenance', () => {
    const getEstimates = () =>
      new ConsumptionManagementService(
        new ComputeEstimator(),
        new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
        new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
        new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
        new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
        new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
        new EmbodiedEmissionsEstimator(
          AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
        ),
        new ConsumptionManagementClient(mockCredentials, subscriptionId),
      ).getEstimates(startDate, endDate, grouping)

    beforeEach(() => {
      mockUsageDetails.list.mockReturnValue(
        mockIterableResponse(mockConsumptionManagementResponseEight),
      )
    })

    afterEach(() => {
      mockResolveOverride = undefined
    })

    it('records the static factor applied to every row, including rows built from unknown usage', async () => {
      const table = AZURE_EMISSIONS_FACTORS_METRIC_TON_PER_KWH
      const results = await getEstimates()
      const estimates = results.flatMap((r) => r.serviceEstimates)
      expect(estimates.length).toBeGreaterThan(0)
      for (const estimate of estimates) {
        const zoneRegion = Object.hasOwn(table, estimate.region)
          ? estimate.region
          : 'Unknown'
        expect(estimate.provenance).toEqual({
          sourceId: 'static',
          zoneId: `azure:${zoneRegion}`,
          granularity: 'year',
          basis: 'location-production',
          factorType: 'direct',
          isEstimated: false,
          licenceId: 'open-attribution',
          qualityTier: 'D',
          gCO2ePerKWh: tonnesToGrams(table[zoneRegion]),
          modelVersion: 'unversioned',
        })
      }
    })

    it('applies the resolved intensity and its provenance to unknown-usage rows as well', async () => {
      const liveTonnesPerKWh = 0.0001
      const liveProvenance = {
        sourceId: 'live-source',
        zoneId: 'TEST',
        granularity: 'hour',
        basis: 'location-consumption',
        factorType: 'lifecycle',
        isEstimated: true,
        licenceId: 'custom',
        qualityTier: 'C',
        gCO2ePerKWh: 100,
        modelVersion: 'unversioned',
      }
      mockResolveOverride = {
        factors: { Unknown: liveTonnesPerKWh },
        provenance: liveProvenance,
      }
      const results = await getEstimates()
      for (const estimate of results.flatMap((r) => r.serviceEstimates)) {
        expect(estimate.provenance).toEqual(liveProvenance)
        // no embodied emissions in this fixture: co2e is kWh times intensity
        expect(estimate.co2e).toBeCloseTo(
          estimate.kilowattHours * liveTonnesPerKWh,
          15,
        )
      }
    })
  })

  it('Returns estimates for Storage', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseTwo),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-02'),
        serviceEstimates: [
          {
            kilowattHours: 0.010374912000000002,
            co2e: 0.0000023343552,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Storage',
            cost: 10,
            region: 'uksouth',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.011157869359725106,
            co2e: 0.000003664244297733725,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Storage',
            cost: 10,
            region: 'westeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.000204768,
            co2e: 6.72458112e-8, // Very very small decimal
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Azure Database for MySQL',
            cost: 5,
            region: 'westeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.00034127999999999996,
            co2e: 1.12076352e-7,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Container Registry',
            cost: 5,
            region: 'westeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.018929664000000002,
            co2e: 0.0000042591744,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'HDInsight',
            cost: 5,
            region: 'uksouth',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.068256,
            co2e: 0.0000153576,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Azure Synapse Analytics',
            cost: 5,
            region: 'uksouth',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.0010238399999999998,
            co2e: 7.250834879999999e-7, // Very very small decimal
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Storage',
            cost: 5,
            region: 'centralindia',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.003276288,
            co2e: 0.0000011508943225029118,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Storage',
            cost: 1,
            region: 'Unknown',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-02T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-02T00:00:00.000Z'),
      },
    ]
    expect(withoutProvenance(result)).toEqual(expectedResult)
  })

  it('Returns estimates for Networking', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseThree),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-02'),
        serviceEstimates: [
          {
            kilowattHours: 0.011850000000000001,
            co2e: 0.00000266625,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Storage',
            cost: 5,
            region: 'uksouth',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 11.850000000000001,
            co2e: 0.0026662500000000002,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Bandwidth',
            cost: 5,
            region: 'uksouth',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-02T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-02T00:00:00.000Z'),
      },
    ]
    expect(withoutProvenance(result)).toEqual(expectedResult)
  })

  it('Returns estimates for Memory', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseFive),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-03'),
        serviceEstimates: [
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 0.00005086835935908219,
            cost: 20,
            region: 'northeurope',
            serviceName: 'Virtual Machines',
            usesAverageCPUConstant: true,
            kilowattHours: 0.18258564019771067,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 0.000018194319360000002,
            cost: 5,
            region: 'apsoutheast',
            serviceName: 'Redis Cache',
            usesAverageCPUConstant: false,
            kilowattHours: 0.04459392,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-03T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-03T00:00:00.000Z'),
      },
      {
        timestamp: new Date('2020-11-02'),
        serviceEstimates: [
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 5.247283512183694e-12,
            cost: 10,
            region: 'EastUS2',
            serviceName: 'Functions',
            usesAverageCPUConstant: false,
            kilowattHours: 0.0000000143710875,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 0.00000151024596203943,
            cost: 7,
            region: 'ukwest',
            serviceName: 'Container Instances',
            usesAverageCPUConstant: false,
            kilowattHours: 0.0067122042757308,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-02T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-02T00:00:00.000Z'),
      },
      {
        timestamp: new Date('2020-11-04'),
        serviceEstimates: [
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 5.662354827490885e-10,
            cost: 10,
            region: 'EastUS',
            serviceName: 'Functions',
            usesAverageCPUConstant: false,
            kilowattHours: 0.0000015507871166666667,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 0.0004625712290192,
            cost: 7,
            region: 'CentralUS',
            serviceName: 'Container Instances',
            usesAverageCPUConstant: false,
            kilowattHours: 1.1830719368513218,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-04T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-04T00:00:00.000Z'),
      },
    ]
    expect(withoutProvenance(result)).toEqual(expectedResult)
  })

  it('Returns estimates for Storage services with replication factors', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseSix),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-03'),
        serviceEstimates: [
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 8.11513651150173e-11,
            cost: 20,
            region: 'WestUS',
            serviceName: 'Storage',
            usesAverageCPUConstant: false,
            kilowattHours: 0.000000271727136,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 4.1804041762606153e-10,
            cost: 15,
            region: 'SouthCentralUS',
            serviceName: 'Storage',
            usesAverageCPUConstant: false,
            kilowattHours: 0.0000012510300960000003,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 6.91092e-13,
            cost: 10,
            region: 'uksouth',
            serviceName: 'Storage',
            usesAverageCPUConstant: false,
            kilowattHours: 3.07152e-9,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 1.681245915404714e-9,
            cost: 5,
            region: 'westus2',
            serviceName: 'Storage',
            usesAverageCPUConstant: false,
            kilowattHours: 0.000005629481856,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-03T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-03T00:00:00.000Z'),
      },
      {
        timestamp: new Date('2020-11-04'),
        serviceEstimates: [
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 0.0000029486592,
            cost: 2,
            region: 'uksouth',
            serviceName: 'Storage',
            usesAverageCPUConstant: false,
            kilowattHours: 0.013105152,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 0.0000012568113792000002,
            cost: 2,
            region: 'westindia',
            serviceName: 'Storage',
            usesAverageCPUConstant: false,
            kilowattHours: 0.0017746560000000003,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-04T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-04T00:00:00.000Z'),
      },
    ]
    expect(withoutProvenance(result)).toEqual(expectedResult)
  })

  it('Returns estimates for Database and Cache services with replication factors', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseSeven),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-03'),
        serviceEstimates: [
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 3.09629032372008e-10,
            cost: 20,
            region: 'uksouth',
            serviceName: 'Azure Database for MySQL',
            usesAverageCPUConstant: false,
            kilowattHours: 0.00000137612903276448,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 0.0000034234649999999996,
            cost: 45,
            region: 'uksouth',
            serviceName: 'SQL Database',
            usesAverageCPUConstant: true,
            kilowattHours: 0.015215399999999999,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-03T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-03T00:00:00.000Z'),
      },
      {
        timestamp: new Date('2020-11-04'),
        serviceEstimates: [
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 0.00004108157999999999,
            cost: 30,
            region: 'uksouth',
            serviceName: 'Azure Database for MySQL',
            usesAverageCPUConstant: true,
            kilowattHours: 0.18258479999999996,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 1.147974780284935e-9,
            cost: 35,
            region: 'CentralUS',
            serviceName: 'Azure Cosmos DB',
            usesAverageCPUConstant: false,
            kilowattHours: 0.00000293605970619456,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: subscriptionId,
            accountName: subscriptionName,
            cloudProvider: 'AZURE',
            co2e: 1.610070967511351e-10,
            cost: 40,
            region: 'uksouth',
            serviceName: 'SQL Database',
            usesAverageCPUConstant: false,
            kilowattHours: 7.155870966717116e-7,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-04T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-04T00:00:00.000Z'),
      },
    ]
    expect(withoutProvenance(result)).toEqual(expectedResult)
  })

  it('Handles Unknown usage and ignores unsupported usage types', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseFour),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    expect(withoutProvenance(result)).toEqual([])
  })

  it('Returns estimates for reclassified unknowns', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseEight),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-02'),
        serviceEstimates: [
          {
            kilowattHours: 0.18258564019771067,
            co2e: 0.00005086835935908219,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Virtual Machines',
            cost: 5,
            region: 'northeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0,
            co2e: 0,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'API Management',
            cost: 1.579140496,
            region: 'northeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-02T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-02T00:00:00.000Z'),
      },
      {
        timestamp: new Date('2020-11-03'),
        serviceEstimates: [
          {
            accountId: 'test-subscription-id',
            accountName: 'test-subscription',
            cloudProvider: 'AZURE',
            co2e: 8.179862341458044e-10,
            cost: 35,
            kilowattHours: 0.00000293605970619456,
            region: 'northeurope',
            serviceName: 'Azure Cosmos DB',
            usesAverageCPUConstant: false,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0,
            co2e: 0,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Advanced Data Security',
            cost: 0.4835702479,
            region: 'northeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-03T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-03T00:00:00.000Z'),
      },
      {
        timestamp: new Date('2020-11-04'),
        serviceEstimates: [
          {
            accountId: 'test-subscription-id',
            accountName: 'test-subscription',
            cloudProvider: 'AZURE',
            co2e: 0.00000330141,
            cost: 5,
            kilowattHours: 0.011850000000000001,
            region: 'northeurope',
            serviceName: 'Storage',
            usesAverageCPUConstant: false,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0,
            co2e: 0,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Load Balancer',
            cost: 0.006280996057,
            region: 'northeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-04T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-04T00:00:00.000Z'),
      },
      {
        timestamp: new Date('2020-11-05'),
        serviceEstimates: [
          {
            accountId: 'test-subscription-id',
            accountName: 'test-subscription',
            cloudProvider: 'AZURE',
            co2e: 0.0000018700201112186009,
            cost: 7,
            kilowattHours: 0.0067122042757308,
            region: 'northeurope',
            serviceName: 'Container Instances',
            usesAverageCPUConstant: false,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0,
            co2e: 0,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Azure Databricks',
            cost: 18,
            region: 'northeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-05T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-05T00:00:00.000Z'),
      },
      {
        timestamp: new Date('2020-11-06'),
        serviceEstimates: [
          {
            accountId: 'test-subscription-id',
            accountName: 'test-subscription',
            cloudProvider: 'AZURE',
            co2e: 0,
            cost: 0.003168316832,
            kilowattHours: 0,
            region: 'All Regions',
            serviceName: 'Azure DNS',
            usesAverageCPUConstant: false,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-06T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-06T00:00:00.000Z'),
      },
    ]

    expect(withoutProvenance(result)).toEqual(expectedResult)
  })

  it('Returns estimates for Compute with Embodied Emissions, and modern usage type', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseNine),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-02'),
        serviceEstimates: [
          {
            kilowattHours: 0.18258564019771067,
            co2e: 0.00005086835935908219,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Virtual Machines',
            cost: 10,
            region: 'northeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.013126433307939065,
            co2e: 0.000004310720698327189,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Virtual Machines',
            cost: 15,
            region: 'westeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 0.2614738305048199,
            co2e: 0.00005883161186358448,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Virtual Machines',
            cost: 5,
            region: 'uksouth',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            accountId: 'test-subscription-id',
            accountName: 'test-subscription',
            cloudProvider: 'AZURE',
            co2e: 0.00007270603983690511,
            cost: 5,
            kilowattHours: 0.19912491060347176,
            region: 'EastUS',
            serviceName: 'Virtual Machines',
            usesAverageCPUConstant: true,
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-02T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-02T00:00:00.000Z'),
      },
    ]
    expect(withoutProvenance(result)).toEqual(expectedResult)
  })

  it('Returns estimates for GPU Virtual Machines', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseEleven),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-02'),
        serviceEstimates: [
          {
            kilowattHours: 0.9444048570032982,
            co2e: 0.00026311119316111894,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Virtual Machines',
            cost: 10,
            region: 'northeurope',
            tags: {
              custom: 'custom-tag-value',
              other: 'other-custom-tag-value',
              resourceGroup: 'first-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-02T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-02T00:00:00.000Z'),
      },
      {
        timestamp: new Date('2020-11-03'),
        serviceEstimates: [
          {
            kilowattHours: 0.942342969281661,
            co2e: 0.00034407561192108005,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Virtual Machines',
            cost: 10,
            region: 'EastUS',
            tags: {
              custom: 'custom-tag-value',
              'created-by': 'created-by-tag-value',
              resourceGroup: 'second-resource-group',
            },
          },
          {
            kilowattHours: 2.774591597330377,
            co2e: 0.0009111758805632959,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Virtual Machines',
            cost: 10,
            region: 'westeurope',
            tags: {
              resourceGroup: 'third-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-03T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-03T00:00:00.000Z'),
      },
    ]
    expect(withoutProvenance(result)).toEqual(expectedResult)
  })

  it('successfully returns estimation for lookup table input data', async () => {
    const inputData: LookupTableInput[] = [
      {
        serviceName: 'Virtual Machines',
        region: 'uksouth',
        usageType: 'D2 v2/DS2 v2',
        usageUnit: '10 Hours',
      },
    ]

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
    )

    const result =
      await consumptionManagementService.getEstimatesFromInputData(inputData)

    const expectedResult: LookupTableOutput[] = [
      {
        serviceName: 'Virtual Machines',
        region: 'uksouth',
        usageType: 'D2 v2/DS2 v2',
        kilowattHours: 0.011945378995278953,
        co2e: 0.000004196172273564499,
      },
    ]

    expect(result).toEqual(expectedResult)
  })

  it('Pages through results', async () => {
    const mockResponse = mockIterableResponse(
      mockConsumptionManagementResponseThree,
    )
    jest.spyOn(mockResponse, 'next')
    mockUsageDetails.list.mockReturnValue(mockResponse)

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-02'),
        serviceEstimates: [
          {
            kilowattHours: 0.011850000000000001,
            co2e: 0.00000266625,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Storage',
            cost: 5,
            region: 'uksouth',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
          {
            kilowattHours: 11.850000000000001,
            co2e: 0.0026662500000000002,
            usesAverageCPUConstant: false,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Bandwidth',
            cost: 5,
            region: 'uksouth',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-02T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-02T00:00:00.000Z'),
      },
    ]
    expect(withoutProvenance(result)).toEqual(expectedResult)
    expect(mockResponse.next).toHaveBeenCalled()
  })

  describe('When group query results by week is true', () => {
    it('Returns estimates for Compute grouped by week', async () => {
      mockUsageDetails.list.mockReturnValue(
        mockIterableResponse(mockConsumptionManagementResponseOne),
      )

      const consumptionManagementService = new ConsumptionManagementService(
        new ComputeEstimator(),
        new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
        new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
        new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
        new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
        new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
        new EmbodiedEmissionsEstimator(
          AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
        ),
        new ConsumptionManagementClient(mockCredentials, subscriptionId),
      )

      const groupingByWeek = GroupBy.week

      const result = await consumptionManagementService.getEstimates(
        startDate,
        endDate,
        groupingByWeek,
      )

      const expectedResult: EstimationResult[] = [
        {
          timestamp: new Date('2020-11-02'),
          serviceEstimates: [
            {
              kilowattHours: 0.2614738305048199,
              co2e: 0.00005883161186358448,
              usesAverageCPUConstant: true,
              cloudProvider: 'AZURE',
              accountId: subscriptionId,
              accountName: subscriptionName,
              serviceName: 'Virtual Machines',
              cost: 5,
              region: 'uksouth',
              tags: {
                resourceGroup: 'test-resource-group',
              },
            },
            {
              kilowattHours: 0.002863085156621724,
              co2e: 9.402371654345742e-7, // Very very small number
              usesAverageCPUConstant: true,
              cloudProvider: 'AZURE',
              accountId: subscriptionId,
              accountName: subscriptionName,
              serviceName: 'Virtual Machines',
              cost: 10,
              region: 'westeurope',
              tags: {
                resourceGroup: 'test-resource-group',
              },
            },
            {
              kilowattHours: 0.07270161248463072,
              co2e: 0.0000284257222161796,
              usesAverageCPUConstant: true,
              cloudProvider: 'AZURE',
              accountId: subscriptionId,
              accountName: subscriptionName,
              serviceName: 'Azure App Service',
              cost: 10,
              region: 'CentralUS',
              tags: {
                resourceGroup: 'test-resource-group',
              },
            },
            {
              kilowattHours: 0.025359,
              co2e: 0.000008473886427252899,
              usesAverageCPUConstant: true,
              cloudProvider: 'AZURE',
              accountId: subscriptionId,
              accountName: subscriptionName,
              serviceName: 'Container Instances',
              cost: 12,
              region: 'SouthCentralUS',
              tags: {
                resourceGroup: 'test-resource-group',
              },
            },
            {
              kilowattHours: 0.18258479999999996,
              co2e: 0.00006413838151448518,
              usesAverageCPUConstant: true,
              cloudProvider: 'AZURE',
              accountId: subscriptionId,
              accountName: subscriptionName,
              serviceName: 'Azure Database for MySQL',
              cost: 12,
              region: 'Unknown',
              tags: {
                resourceGroup: 'test-resource-group',
              },
            },
            {
              accountId: 'test-subscription-id',
              accountName: 'test-subscription',
              cloudProvider: 'AZURE',
              co2e: 0.00004108157999999999,
              cost: 12,
              kilowattHours: 0.18258479999999996,
              region: 'ukwest',
              serviceName: 'Virtual Machines Licenses',
              usesAverageCPUConstant: false,
              tags: {
                resourceGroup: 'test-resource-group',
              },
            },
            {
              accountId: 'test-subscription-id',
              accountName: 'test-subscription',
              cloudProvider: 'AZURE',
              co2e: 0.00006413838151448518,
              cost: 12,
              kilowattHours: 0.18258479999999996,
              region: 'Unknown',
              serviceName: 'VPN Gateway',
              usesAverageCPUConstant: false,
              tags: {
                resourceGroup: 'test-resource-group',
              },
            },
          ],
          groupBy: GroupBy.week,
          periodEndDate: new Date('2020-11-08T23:59:59.000Z'),
          periodStartDate: new Date('2020-11-02T00:00:00.000Z'),
        },
      ]
      expect(withoutProvenance(result)).toEqual(expectedResult)
    })
  })

  it('Returns estimates filtered within the start and end date', async () => {
    mockUsageDetails.list.mockReturnValue(
      mockIterableResponse(mockConsumptionManagementResponseTen),
    )

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )

    const expectedResult: EstimationResult[] = [
      {
        timestamp: new Date('2020-11-07'),
        serviceEstimates: [
          {
            kilowattHours: 0.013126433307939065,
            co2e: 0.000004310720698327189,
            usesAverageCPUConstant: true,
            cloudProvider: 'AZURE',
            accountId: subscriptionId,
            accountName: subscriptionName,
            serviceName: 'Virtual Machines',
            cost: 15,
            region: 'westeurope',
            tags: {
              resourceGroup: 'test-resource-group',
            },
          },
        ],
        groupBy: grouping,
        periodEndDate: new Date('2020-11-07T23:59:59.000Z'),
        periodStartDate: new Date('2020-11-07T00:00:00.000Z'),
      },
    ]
    expect(withoutProvenance(result)).toEqual(expectedResult)
  })

  it('splits and queries time ranges correctly', async () => {
    setConfig({
      ...DEFAULT_CONFIG,
      AZURE: {
        ...DEFAULT_CONFIG.AZURE,
        CONSUMPTION_CHUNKS_DAYS: 7,
      },
    })

    mockUsageDetails.list.mockClear()

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    const startDate = new Date('2022-01-01')
    const endDate = new Date('2022-02-01')

    const result = await consumptionManagementService.getEstimates(
      startDate,
      endDate,
      GroupBy.day,
    )

    const expectedScope = `/subscriptions/${subscriptionId}/`

    expect(mockUsageDetails.list).toHaveBeenNthCalledWith(1, expectedScope, {
      expand: 'properties/meterDetails',
      filter: `properties/usageStart ge '2022-01-01T00:00:00.000Z' AND properties/usageEnd lt '2022-01-07T23:59:59.999Z'`,
    })
    expect(mockUsageDetails.list).toHaveBeenNthCalledWith(2, expectedScope, {
      expand: 'properties/meterDetails',
      filter: `properties/usageStart ge '2022-01-08T00:00:00.000Z' AND properties/usageEnd lt '2022-01-14T23:59:59.999Z'`,
    })
    expect(mockUsageDetails.list).toHaveBeenNthCalledWith(3, expectedScope, {
      expand: 'properties/meterDetails',
      filter: `properties/usageStart ge '2022-01-15T00:00:00.000Z' AND properties/usageEnd lt '2022-01-21T23:59:59.999Z'`,
    })
    expect(mockUsageDetails.list).toHaveBeenNthCalledWith(4, expectedScope, {
      expand: 'properties/meterDetails',
      filter: `properties/usageStart ge '2022-01-22T00:00:00.000Z' AND properties/usageEnd lt '2022-01-28T23:59:59.999Z'`,
    })
    expect(mockUsageDetails.list).toHaveBeenNthCalledWith(5, expectedScope, {
      expand: 'properties/meterDetails',
      // here it is important, that the last call uses 'le' to include the last date!
      filter: `properties/usageStart ge '2022-01-29T00:00:00.000Z' AND properties/usageEnd le '2022-02-01T00:00:00.000Z'`,
    })
    expect(withoutProvenance(result)).toEqual([])
  })

  // Note: Might need to consider test and try/catch retry logic.
  // usageDetails.list synchronously returns iterator and does not do API call nor affects rate limit
  xit('Throws an error when usageDetails.list fails', async () => {
    const errorMessage = 'Something went wrong!'

    mockUsageDetails.list.mockImplementation(() => {
      throw new Error(errorMessage)
    })

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )
    await expect(() =>
      consumptionManagementService.getEstimates(startDate, endDate, grouping),
    ).rejects.toThrow(
      `Azure ConsumptionManagementClient.usageDetails.list failed. Reason: ${errorMessage}`,
    )
  })

  it('Throws an error when iteration on a usageRow fails', async () => {
    const errorMessage = 'Something went wrong!'
    const _headersMap = new Map([
      ["'x-ms-ratelimit-remaining-microsoft.consumption-tenant-requests':", 1],
    ])
    const testError = {
      message: errorMessage,
      response: {
        headers: {
          _headersMap,
        },
      },
    }
    const mockResponse = mockIterableResponse(
      mockConsumptionManagementResponseOne,
    )
    const nextPageSpy = jest.spyOn(mockResponse, 'next')
    mockUsageDetails.list.mockReturnValue(mockResponse)
    nextPageSpy.mockRejectedValue(testError)

    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(mockCredentials, subscriptionId),
    )

    await expect(() =>
      consumptionManagementService.getEstimates(startDate, endDate, grouping),
    ).rejects.toThrow(
      `Azure ConsumptionManagementClient UsageDetailRow query for time range 2020-11-02T00:00:00.000Z to 2020-11-07T00:00:00.000Z failed. Reason: ${errorMessage}`,
    )
  })
})
