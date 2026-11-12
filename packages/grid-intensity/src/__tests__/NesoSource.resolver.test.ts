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
import { InMemoryIntensityStore } from '../stores/InMemoryIntensityStore'
import { LocalIntensityStore } from '../stores/LocalIntensityStore'
import { IntensityStore, ProviderRegion } from '../types'
import {
  generatedRange,
  jsonResponse,
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

  const createResolver = ({
    store,
    fetch = api.fetch,
    now = () => NOW,
  }: {
    store?: IntensityStore
    fetch?: NesoApiMock['fetch']
    now?: () => Date
  } = {}) => {
    const logger = { warn: jest.fn() }
    const resolver = new GridIntensityResolver({
      sources: [
        new NesoSource({ fetch, now, minRequestIntervalMs: 0 }),
        new StaticSource({ AWS: awsTable }, now),
      ],
      ...(store ? { store } : {}),
      logger,
      now,
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

  it('sends one request when several calls resolve the same day at once', async () => {
    api.generate(actualOf)
    const { resolver } = createResolver()

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
      ),
    )

    expect(results.map((result) => result.gCO2ePerKWh)).toEqual(
      Array.from({ length: 8 }, () => DAY_MEAN),
    )
    expect(api.urls()).toEqual([DAY_URL])
  })

  it('keeps the days it read when a later request of a month fails, and a new process asks only for the rest', async () => {
    // October 2026 as one usage period is three requests. The third is
    // refused, in the form a gateway answers in (not recorded).
    const OCTOBER = utc('2026-10-01T00:00:00.000Z')
    const NOVEMBER = utc('2026-11-01T00:00:00.000Z')
    const urls = [
      `${NESO_API}/intensity/2026-10-01T00:00Z/2026-10-15T00:00Z`,
      `${NESO_API}/intensity/2026-10-15T00:00Z/2026-10-29T00:00Z`,
      `${NESO_API}/intensity/2026-10-29T00:00Z/2026-11-01T00:00Z`,
    ]
    api.generate(actualOf)
    api.respondTo(urls[2], () =>
      jsonResponse({ message: 'Too Many Requests' }, 429),
    )
    const store = new InMemoryIntensityStore()
    const { resolver, logger } = createResolver({ store })

    const result = await resolver.resolve('AWS', 'eu-west-2', OCTOBER, NOVEMBER)

    expect(api.urls()).toEqual(urls)
    // 28 of the 31 days.
    expect(result.points).toHaveLength(28 * 24)
    expect(result.provenance).toMatchObject({
      sourceId: 'neso',
      isEstimated: true,
      qualityTier: 'C',
      isProvisional: true,
    })
    expect(logger.warn.mock.calls).toEqual([
      [
        'Grid intensity source neso fetch failed for zone national: NESO Carbon Intensity API: GET /intensity/2026-10-29T00:00Z/2026-11-01T00:00Z failed: HTTP 429: Too Many Requests. Skipping it for 24 hours.',
      ],
    ])

    // A later process on the same store, with NESO answering again.
    const later = mockNesoApi()
    later.generate(actualOf)
    const again = await createResolver({
      store,
      fetch: later.fetch,
    }).resolver.resolve('AWS', 'eu-west-2', OCTOBER, NOVEMBER)

    expect(later.urls()).toEqual([urls[2]])
    expect(again.points).toHaveLength(31 * 24)
    expect(again.gCO2ePerKWh).toBe(DAY_MEAN)
    expect(again.provenance).toMatchObject({
      sourceId: 'neso',
      isEstimated: false,
    })
    expect(again.provenance).not.toHaveProperty('isProvisional')
    later.assertNoUnknownRequests()
  })

  it('warns and uses the static factor when no period of an answer is in the form it knows', async () => {
    // The recorded shape, with the datetimes written another way.
    api.respondTo(DAY_URL, () =>
      jsonResponse({
        data: generatedRange(DAY_START, DAY_END, actualOf).data.map(
          (period) => ({
            ...period,
            from: period.from.replace('Z', '+00:00'),
            to: period.to.replace('Z', '+00:00'),
          }),
        ),
      }),
    )
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
      qualityTier: 'D',
      isProvisional: true,
    })
    expect(logger.warn.mock.calls).toEqual([
      [
        'Grid intensity source neso fetch failed for zone national: NESO Carbon Intensity API: GET /intensity/2026-11-03T00:00Z/2026-11-04T00:00Z failed: HTTP 200 with 49 periods, none of them in the expected form. Skipping it for 24 hours.',
      ],
    ])
    expect(api.urls()).toEqual([DAY_URL])
  })

  describe('as time goes by in one process', () => {
    let nowMs: number
    const now = () => new Date(nowMs)
    const MINUTE_MS = 60 * 1000

    beforeEach(() => {
      nowMs = NOW.getTime()
    })

    it('asks again after an hour for an hour that was late, and then has the whole day', async () => {
      // Yesterday, of which the hour from 22:00 has only one half so far.
      let late = true
      api.generate((periodStart) =>
        late && periodStart.toISOString() === '2026-11-11T22:30:00.000Z'
          ? null
          : actualOf(periodStart),
      )
      const { resolver } = createResolver({ now })
      const resolveYesterday = () =>
        resolver.resolve(
          'AWS',
          'eu-west-2',
          utc('2026-11-11T00:00:00.000Z'),
          utc('2026-11-12T00:00:00.000Z'),
        )

      const first = await resolveYesterday()
      expect(first.points).toHaveLength(23)
      expect(first.provenance).toMatchObject({
        qualityTier: 'C',
        isProvisional: true,
      })

      nowMs += 59 * MINUTE_MS
      await resolveYesterday()
      expect(api.urls()).toHaveLength(1)

      late = false
      nowMs += 2 * MINUTE_MS
      const later = await resolveYesterday()
      expect(api.urls()).toEqual([
        `${NESO_API}/intensity/2026-11-11T00:00Z/2026-11-12T00:00Z`,
        `${NESO_API}/intensity/2026-11-11T22:00Z/2026-11-11T23:00Z`,
      ])
      expect(later.points).toHaveLength(24)
      expect(later.gCO2ePerKWh).toBe(DAY_MEAN)
      expect(later.provenance).toMatchObject({ qualityTier: 'B' })
      expect(later.provenance).not.toHaveProperty('isProvisional')
    })

    it('picks up, an hour later, the hour NESO has offered since', async () => {
      api.generate(actualOf)
      const { resolver } = createResolver({ now })
      const resolveToday = () =>
        resolver.resolve(
          'AWS',
          'eu-west-2',
          utc('2026-11-12T00:00:00.000Z'),
          utc('2026-11-13T00:00:00.000Z'),
        )

      // At 09:30 the data ends at 07:00.
      await expect(resolveToday()).resolves.toMatchObject({
        points: { length: 7 },
      })
      // At 10:29 the answer about the end of the data is not an hour old.
      nowMs += 59 * MINUTE_MS
      await resolveToday()
      expect(api.urls()).toHaveLength(1)
      // At 10:31 it is, and the data ends at 08:00.
      nowMs += 2 * MINUTE_MS
      const later = await resolveToday()
      expect(api.urls()).toEqual([
        `${NESO_API}/intensity/2026-11-12T00:00Z/2026-11-12T07:00Z`,
        `${NESO_API}/intensity/2026-11-12T07:00Z/2026-11-12T08:00Z`,
      ])
      expect(later.points).toHaveLength(8)
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

  it('sends one request when calls for one region are made at once, as recommendations are', async () => {
    // packages/gcp prices every recommendation under one Promise.all, and
    // each asks the adapter for the same day. The spacing is the default
    // second, so a second request would also show as a wait.
    api.generate(actualOf)

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolveEmissionsFactors('GCP', 'europe-west2', DAY_START, DAY_END, {
          factors: { 'europe-west2': 0.000106 },
        }),
      ),
    )

    for (const result of results) {
      expect(result.factors).toEqual({ 'europe-west2': 0.0001235 })
      expect(result.provenance).toMatchObject({ sourceId: 'neso' })
    }
    expect(api.urls()).toEqual([DAY_URL])
  })

  it('reads the store file once for the rows of one region and day', async () => {
    api.generate(actualOf)
    const read = jest.spyOn(LocalIntensityStore.prototype, 'get')
    try {
      for (let row = 0; row < 50; row++)
        await resolveEmissionsFactors(
          'AWS',
          'eu-west-2',
          DAY_START,
          DAY_END,
          awsTable,
        )
      // Before the hours are fetched, and once after they are stored.
      expect(read).toHaveBeenCalledTimes(2)
      expect(api.urls()).toEqual([DAY_URL])
    } finally {
      read.mockRestore()
    }
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
