/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { configLoader } from '@cloud-carbon-footprint/common'
import { GridIntensityCapabilityReporter } from '../CapabilityReporter'
import { GridIntensityResolver } from '../GridIntensityResolver'
import {
  resetDefaultResolver,
  resolveEmissionsFactors,
  shutdownDefaultResolver,
} from '../resolveEmissionsFactors'
import { NesoSource } from '../sources/NesoSource'
import { StaticFactorTable, StaticSource } from '../sources/StaticSource'
import { ProviderRegion } from '../types'
import {
  mockNesoApi,
  NESO_API,
  NesoApiMock,
  nesoFixture,
} from './fixtures/nesoApi'

/*
 * The NESO source behind the resolver and behind the adapter the provider
 * packages call. No test calls the network. The fixtures hold a few half
 * hours each, so the stand-in generates whole days in the recorded shape
 * (generatedRange in fixtures/nesoApi.ts).
 */

const mockWarn = jest.fn()
jest.mock('mongodb', () => ({
  MongoClient: jest.fn(),
  ServerApiVersion: { v1: '1' },
}))
jest.mock('@cloud-carbon-footprint/common', () => ({
  configLoader: jest.fn(),
  Logger: jest.fn().mockImplementation(() => ({ warn: mockWarn })),
}))

const utc = (iso: string) => new Date(iso)

/** A whole UTC day, nine days before NOW. */
const DAY_START = utc('2026-11-03T00:00:00.000Z')
const DAY_END = utc('2026-11-04T00:00:00.000Z')
const DAY_URL = `${NESO_API}/intensity/2026-11-03T00:00Z/2026-11-04T00:00Z`
const NOW = utc('2026-11-12T09:30:00.000Z')

/**
 * The half hours of hour h read 100 + 2h and 101 + 2h, so the hour's mean
 * is 100.5 + 2h and the mean of a whole day is 123.5.
 */
const actualOf = (periodStart: Date): number =>
  100 + 2 * periodStart.getUTCHours() + (periodStart.getUTCMinutes() ? 1 : 0)
const DAY_MEAN = 123.5

const awsFactors = { 'eu-west-2': 0.000305, 'us-east-1': 0.0004 }
const awsTable: StaticFactorTable = { factors: awsFactors }

describe('NesoSource behind the resolver', () => {
  let api: NesoApiMock

  beforeEach(() => {
    api = mockNesoApi()
  })

  afterEach(() => {
    api.assertNoUnknownRequests()
  })

  const createResolver = () => {
    const logger = { warn: jest.fn() }
    const resolver = new GridIntensityResolver({
      sources: [
        new NesoSource({
          fetch: api.fetch,
          now: () => NOW,
          minRequestIntervalMs: 0,
        }),
        new StaticSource({ AWS: awsTable }, () => NOW),
      ],
      logger,
      now: () => NOW,
    })
    return { resolver, logger }
  }

  it('resolves a past UTC day for AWS eu-west-2 from NESO, at tier B', async () => {
    api.generate(actualOf)
    const { resolver, logger } = createResolver()

    const result = await resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_START,
      DAY_END,
    )

    expect(result.gCO2ePerKWh).toBe(DAY_MEAN)
    expect(result.provenance).toEqual({
      sourceId: 'neso',
      zoneId: 'national',
      granularity: 'hour',
      basis: 'location-consumption',
      factorType: 'direct',
      isEstimated: false,
      licenceId: 'CC-BY-4.0',
      qualityTier: 'B',
      gCO2ePerKWh: DAY_MEAN,
      modelVersion: 'unversioned',
    })
    expect(result.points).toHaveLength(24)
    expect(result.points.map((point) => point.gCO2ePerKWh)).toEqual(
      Array.from({ length: 24 }, (_, hour) => 100.5 + 2 * hour),
    )
    // One request for the whole day, on hour boundaries.
    expect(api.urls()).toEqual([DAY_URL])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('asks NESO once for a day and answers the next call from the store', async () => {
    api.generate(actualOf)
    const { resolver } = createResolver()

    await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    const again = await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)

    expect(again.provenance.sourceId).toBe('neso')
    expect(again.gCO2ePerKWh).toBe(DAY_MEAN)
    expect(api.urls()).toEqual([DAY_URL])
  })

  it('gives tier C, estimated, for a day with one hour missing, and keeps NESO over the static factor', async () => {
    // The second half of the hour from 07:00 has no actual value.
    api.generate((periodStart) =>
      periodStart.toISOString() === '2026-11-03T07:30:00.000Z'
        ? null
        : actualOf(periodStart),
    )
    const { resolver, logger } = createResolver()

    const result = await resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_START,
      DAY_END,
    )

    // The mean of the 23 hours that have a point.
    const mean = (24 * DAY_MEAN - 114.5) / 23
    expect(result.points).toHaveLength(23)
    expect(result.gCO2ePerKWh).toBeCloseTo(mean, 9)
    expect(result.provenance).toMatchObject({
      sourceId: 'neso',
      zoneId: 'national',
      granularity: 'hour',
      isEstimated: true,
      qualityTier: 'C',
      licenceId: 'CC-BY-4.0',
    })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it.each([
    [
      'answers with an error',
      (url: string) => api.serveAs(url, nesoFixture('error-range-too-long')),
      'HTTP 400: The date range you have specified is greater than 31 days. Please select a smaller date range.',
    ],
    [
      'cannot be reached',
      (url: string) =>
        api.respondTo(url, () => {
          throw new TypeError('fetch failed', {
            cause: new Error('connect ETIMEDOUT 203.0.113.1:443'),
          })
        }),
      'fetch failed: connect ETIMEDOUT 203.0.113.1:443',
    ],
  ])(
    'falls back to the static factor when NESO %s, warns once and does not ask again',
    async (_case, fail, reason) => {
      fail(DAY_URL)
      const { resolver, logger } = createResolver()

      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)

      expect(result.gCO2ePerKWh).toBe(305)
      expect(result.provenance).toMatchObject({
        sourceId: 'static',
        zoneId: 'aws:eu-west-2',
        qualityTier: 'D',
        licenceId: 'open-attribution',
      })
      expect(logger.warn.mock.calls).toEqual([
        [
          `Grid intensity source neso fetch failed for zone national: NESO Carbon Intensity API: GET /intensity/2026-11-03T00:00Z/2026-11-04T00:00Z failed: ${reason}. Skipping it for 24 hours.`,
        ],
      ])
      expect(api.urls()).toEqual([DAY_URL])
    },
  )

  it('asks only for hours that ended at least the hold-back ago', async () => {
    // At 09:30 the data ends at 07:00, so today is served from seven hours
    // and marked estimated.
    api.generate(actualOf)
    const { resolver } = createResolver()

    const result = await resolver.resolve(
      'AWS',
      'eu-west-2',
      utc('2026-11-12T00:00:00.000Z'),
      utc('2026-11-13T00:00:00.000Z'),
    )

    expect(api.urls()).toEqual([
      `${NESO_API}/intensity/2026-11-12T00:00Z/2026-11-12T07:00Z`,
    ])
    expect(result.points).toHaveLength(7)
    expect(result.provenance).toMatchObject({
      sourceId: 'neso',
      isEstimated: true,
      qualityTier: 'C',
    })
  })

  describe('in the capability report the doctor prints', () => {
    const regions: ProviderRegion[] = [
      { provider: 'AWS', region: 'eu-west-2' },
      { provider: 'AZURE', region: 'uksouth' },
      { provider: 'AZURE', region: 'ukwest' },
      { provider: 'GCP', region: 'europe-west2' },
      { provider: 'AWS', region: 'us-east-1' },
    ]
    const report = async () => {
      const { resolver } = createResolver()
      const { regions: reported } = await new GridIntensityCapabilityReporter({
        resolver,
        regions,
        now: () => NOW,
      }).capabilities()
      // NESO is the first source of each region.
      return reported.map((region) => region.sources[0])
    }

    it('offers tier B for the four Great Britain regions, with its attribution, after one probe', async () => {
      const probe = nesoFixture('national-current')
      api.serve(probe)

      const neso = await report()

      expect(neso.slice(0, 4)).toEqual(
        Array.from({ length: 4 }, () => ({
          sourceId: 'neso',
          zoneId: 'national',
          licenceState: 'open',
          bestTier: { last24Hours: 'B', last30Days: 'B', last12Months: 'B' },
          coverage: { last24Hours: 1, last30Days: 1, last12Months: 1 },
          attribution:
            'Contains data from the Carbon Intensity API by National Energy System Operator (NESO), https://carbonintensity.org.uk, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Half-hourly values averaged to hours.',
        })),
      )
      expect(neso[4]).toMatchObject({
        sourceId: 'neso',
        zoneId: null,
        licenceState: 'unavailable',
      })
      // The current half hour, once, and no intensity data.
      expect(api.urls()).toEqual([probe.request.url])
    })

    it('shows why NESO cannot be reached', async () => {
      api.respondTo(`${NESO_API}/intensity`, () => {
        throw new TypeError('fetch failed', {
          cause: new Error('getaddrinfo ENOTFOUND api.carbonintensity.org.uk'),
        })
      })

      const [awsLondon] = await report()

      expect(awsLondon).toMatchObject({
        sourceId: 'neso',
        zoneId: 'national',
        bestTier: { last24Hours: 'B', last30Days: 'B', last12Months: 'B' },
        error:
          'NESO Carbon Intensity API: GET /intensity failed: fetch failed: getaddrinfo ENOTFOUND api.carbonintensity.org.uk',
      })
    })
  })

  it('does not ask NESO about a region outside Great Britain', async () => {
    const { resolver } = createResolver()

    const result = await resolver.resolve(
      'AWS',
      'us-east-1',
      DAY_START,
      DAY_END,
    )

    expect(result.provenance.sourceId).toBe('static')
    expect(api.fetch).not.toHaveBeenCalled()
  })
})

describe('resolveEmissionsFactors with GRID_INTENSITY_SOURCES=neso,static', () => {
  const realFetch = global.fetch
  let api: NesoApiMock
  let directory: string

  // The default resolver and its source read the system clock, so these
  // tests use a day that is long past: DAY_START, in November 2026.
  beforeEach(async () => {
    jest.clearAllMocks()
    resetDefaultResolver()
    api = mockNesoApi()
    // The default resolver's source is given no fetch of its own.
    global.fetch = api.fetch
    // The LOCAL store, in a directory of this test's own.
    directory = await mkdtemp(join(tmpdir(), 'grid-intensity-neso-'))
    ;(configLoader as jest.Mock).mockReturnValue({
      MONGODB: {},
      GRID_INTENSITY: {
        SOURCES: ['neso', 'static'],
        LICENCE_ACKNOWLEDGEMENTS: [],
        CAPABILITY_TTL_HOURS: 24,
        STORE: 'LOCAL',
        STORE_PATH: directory,
      },
    })
  })

  afterEach(async () => {
    global.fetch = realFetch
    await shutdownDefaultResolver()
    await rm(directory, { recursive: true, force: true })
    api.assertNoUnknownRequests()
  })

  it('resolves a Great Britain region from NESO with the default resolver', async () => {
    api.generate(actualOf)

    const result = await resolveEmissionsFactors(
      'AWS',
      'eu-west-2',
      DAY_START,
      DAY_END,
      awsTable,
    )

    expect(result.factors).toEqual({ 'eu-west-2': 0.0001235 })
    expect(result.provenance).toEqual({
      sourceId: 'neso',
      zoneId: 'national',
      granularity: 'hour',
      basis: 'location-consumption',
      factorType: 'direct',
      isEstimated: false,
      licenceId: 'CC-BY-4.0',
      qualityTier: 'B',
      gCO2ePerKWh: DAY_MEAN,
      modelVersion: 'unversioned',
    })
    expect(api.urls()).toEqual([DAY_URL])
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it('stores the hours, so the other Great Britain regions need no request', async () => {
    api.generate(actualOf)

    await resolveEmissionsFactors(
      'AWS',
      'eu-west-2',
      DAY_START,
      DAY_END,
      awsTable,
    )
    const azure = await resolveEmissionsFactors(
      'AZURE',
      'uksouth',
      DAY_START,
      DAY_END,
      { factors: { uksouth: 0.000225 } },
    )
    const gcp = await resolveEmissionsFactors(
      'GCP',
      'europe-west2',
      DAY_START,
      DAY_END,
      { factors: { 'europe-west2': 0.000106 } },
    )

    expect(azure.factors).toEqual({ uksouth: 0.0001235 })
    expect(gcp.factors).toEqual({ 'europe-west2': 0.0001235 })
    expect(gcp.provenance).toMatchObject({
      sourceId: 'neso',
      zoneId: 'national',
    })
    expect(api.urls()).toEqual([DAY_URL])
    await expect(readdir(join(directory, 'neso', 'national'))).resolves.toEqual(
      ['2026-11.hour.json'],
    )
  })

  it('leaves a region outside Great Britain on the static factors, and asks NESO nothing', async () => {
    const result = await resolveEmissionsFactors(
      'AWS',
      'us-east-1',
      DAY_START,
      DAY_END,
      awsTable,
    )

    expect(result.factors).toBe(awsFactors)
    expect(result.provenance).toMatchObject({
      sourceId: 'static',
      zoneId: 'aws:us-east-1',
      qualityTier: 'D',
    })
    expect(api.fetch).not.toHaveBeenCalled()
  })

  it('falls back to the static factors when NESO fails, with one warning', async () => {
    api.serveAs(DAY_URL, nesoFixture('error-unknown-path'))

    const result = await resolveEmissionsFactors(
      'AWS',
      'eu-west-2',
      DAY_START,
      DAY_END,
      awsTable,
    )

    expect(result.factors).toBe(awsFactors)
    expect(result.provenance).toMatchObject({
      sourceId: 'static',
      qualityTier: 'D',
    })
    expect(mockWarn.mock.calls).toEqual([
      [
        'Grid intensity source neso fetch failed for zone national: NESO Carbon Intensity API: GET /intensity/2026-11-03T00:00Z/2026-11-04T00:00Z failed: HTTP 200: Please enter a valid path e.g. /intensity/. Skipping it for 24 hours.',
      ],
    ])
  })
})
