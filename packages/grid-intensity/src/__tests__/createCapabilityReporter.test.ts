/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { configLoader } from '@cloud-carbon-footprint/common'
import {
  createCapabilityReporter,
  resetDefaultResolver,
  resolveEmissionsFactors,
  shutdownDefaultResolver,
} from '../resolveEmissionsFactors'
import { MongoDbIntensityStore } from '../stores/MongoDbIntensityStore'
import { ProviderRegion } from '../types'

jest.mock('mongodb', () => ({
  MongoClient: jest.fn(),
  ServerApiVersion: { v1: '1' },
}))
jest.mock('@cloud-carbon-footprint/common', () => ({
  configLoader: jest.fn(),
  Logger: jest.fn().mockImplementation(() => ({ warn: jest.fn() })),
}))

const mockConfig = (config: Record<string, unknown> = {}) =>
  (configLoader as jest.Mock).mockReturnValue({
    MONGODB: {},
    GRID_INTENSITY: { SOURCES: ['static'], LICENCE_ACKNOWLEDGEMENTS: [] },
    ...config,
  })

const regions: ProviderRegion[] = [
  { provider: 'AWS', region: 'eu-west-2' },
  { provider: 'GCP', region: 'us-central1' },
  { provider: 'AZURE', region: 'uksouth' },
]
const input = {
  regions,
  staticTables: {
    AWS: { factors: { 'eu-west-2': 0.000305, Unknown: 0.0004 } },
    GCP: { factors: () => ({ 'us-central1': 0.000456 }) },
    AZURE: { factors: { uksouth: 0.000225 } },
  },
}

describe('createCapabilityReporter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetDefaultResolver()
    mockConfig()
  })

  it('reports tier D from the static tables it is given, with the default configuration', async () => {
    const report = await createCapabilityReporter(input).capabilities()

    expect(
      report.regions.map(({ provider, region, sources }) => ({
        provider,
        region,
        sources: sources.map(
          ({ sourceId, zoneId, licenceState, bestTier }) => ({
            sourceId,
            zoneId,
            licenceState,
            bestTier,
          }),
        ),
      })),
    ).toEqual(
      [
        ['AWS', 'eu-west-2', 'aws:eu-west-2'],
        ['GCP', 'us-central1', 'gcp:us-central1'],
        ['AZURE', 'uksouth', 'azure:uksouth'],
      ].map(([provider, region, zoneId]) => ({
        provider,
        region,
        sources: [
          {
            sourceId: 'static',
            zoneId,
            licenceState: 'open',
            bestTier: { last24Hours: 'D', last30Days: 'D', last12Months: 'D' },
          },
        ],
      })),
    )
    expect(report.regions.map((region) => region.gridZoneId)).toEqual([
      'GB',
      'US-MIDW-MISO',
      'GB',
    ])
  })

  it('reports on the default resolver that estimates use, without building another', async () => {
    await resolveEmissionsFactors(
      'AWS',
      'eu-west-2',
      new Date('2026-03-10T00:00:00.000Z'),
      new Date('2026-03-11T00:00:00.000Z'),
      input.staticTables.AWS,
    )
    await createCapabilityReporter(input).capabilities()
    // One read of the configuration, to build the resolver.
    expect(configLoader).toHaveBeenCalledTimes(1)
  })

  it('builds the default resolver when there is none, so that shutdownDefaultResolver closes its store', async () => {
    mockConfig({
      GRID_INTENSITY: { SOURCES: ['static'], STORE: 'MONGODB' },
      MONGODB: { URI: 'mongodb://db:27017' },
    })
    const close = jest
      .spyOn(MongoDbIntensityStore.prototype, 'close')
      .mockResolvedValue(undefined)
    await createCapabilityReporter(input).capabilities()
    await shutdownDefaultResolver()
    expect(close).toHaveBeenCalledTimes(1)
    close.mockRestore()
  })
})
