/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * App with its estimates cache: the real @cache() decorator and the real
 * local cache manager, on cache files in a temporary directory. Only the
 * estimation that asks the cloud providers is replaced. The other tests of
 * App replace the decorator, and the tests of the decorator replace the
 * cache manager.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  EstimationResult,
  getPeriodEndDate,
  GroupBy,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import { EstimationRequest } from '../CreateValidRequest'

const rowOf = (
  cloudProvider: string,
  serviceName: string,
  isProvisional = false,
): ServiceData => ({
  cloudProvider,
  kilowattHours: 1.5,
  co2e: 0.0005,
  cost: 2,
  usesAverageCPUConstant: false,
  accountId: 'account',
  accountName: 'account',
  serviceName,
  region: 'eu-west-2',
  provenance: {
    sourceId: 'live',
    zoneId: 'GB',
    granularity: 'day',
    basis: 'location-consumption',
    factorType: 'direct',
    isEstimated: false,
    licenceId: 'CC-BY-4.0',
    qualityTier: 'B',
    gCO2ePerKWh: 100,
    modelVersion: 'unversioned',
    ...(isProvisional && { isProvisional: true }),
  },
})

const dayOf = (
  date: string,
  serviceEstimates: ServiceData[],
): EstimationResult => ({
  timestamp: new Date(date),
  serviceEstimates,
  periodStartDate: new Date(date),
  periodEndDate: getPeriodEndDate(new Date(date), GroupBy.day),
  groupBy: GroupBy.day,
})

/** The text of a cache file: a JSON array with one estimation result per line. */
const cacheText = (estimates: EstimationResult[]) =>
  '[\n' + estimates.map((e) => JSON.stringify(e)).join('\n,\n') + '\n]'

const namesOf = (estimates: EstimationResult[]) =>
  estimates.map(({ timestamp, serviceEstimates }) => [
    new Date(timestamp).toISOString().slice(0, 10),
    serviceEstimates.map((row) => `${row.cloudProvider} ${row.serviceName}`),
  ])

describe('App and its estimates cache', () => {
  // Each test loads App and the provider packages anew, which takes one to
  // two seconds for the first test where this was written. Jest's five
  // seconds leave little room for that on a slower or busier machine.
  jest.setTimeout(30000)

  const saved: Record<string, string | undefined> = {}
  let directory: string
  let cacheFile: string
  let estimation: jest.SpyInstance
  let App: typeof import('../App').default
  let LocalCacheManager: typeof import('../LocalCacheManager').default

  const seedCache = (estimates: EstimationResult[]) =>
    writeFile(cacheFile, cacheText(estimates), 'utf8')
  const readCache = () => readFile(cacheFile, 'utf8')

  const cached = () => [
    dayOf('2026-11-01', [rowOf('AWS', 'cached')]),
    dayOf('2026-11-02', [rowOf('AWS', 'cached', true), rowOf('GCP', 'cached')]),
    dayOf('2026-11-03', [rowOf('AWS', 'cached', true)]),
  ]

  /** The estimation answers with one new AWS row for each of the dates. */
  const estimationReturns = (...dates: string[]) =>
    estimation.mockResolvedValue(
      dates.map((date) => dayOf(date, [rowOf('AWS', 'new')])),
    )

  beforeEach(async () => {
    for (const name of ['CCF_CACHE_PATH', 'TEST_MODE', 'CACHE_MODE']) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    directory = await mkdtemp(join(tmpdir(), 'estimates-cache-'))
    process.env.CCF_CACHE_PATH = join(directory, 'estimates.cache')
    cacheFile = join(directory, 'estimates.cache.day.json')
    // Each test loads App anew, with the configuration the environment
    // gives. The cache managers of the decorator live as long as the module
    // does, and they keep the estimates of the last request that estimated
    // something.
    jest.resetModules()
    App = jest.requireActual('../App').default
    LocalCacheManager = jest.requireActual('../LocalCacheManager').default
    estimation = jest
      .spyOn(App.prototype, 'getCostAndEstimatesWithoutCache')
      .mockResolvedValue([])
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  describe('getCostAndEstimates', () => {
    const request: EstimationRequest = {
      startDate: new Date('2026-11-01'),
      endDate: new Date('2026-11-03'),
      ignoreCache: false,
      groupBy: 'day',
    }

    it('estimates the dates that are not cached, without the cache, and caches them', async () => {
      await seedCache([cached()[0]])
      estimationReturns('2026-11-02', '2026-11-03')

      const estimates = await new App().getCostAndEstimates(request)

      expect(estimation.mock.calls).toEqual([
        [
          {
            startDate: new Date('2026-11-02T00:00:00.000Z'),
            endDate: new Date('2026-11-03T23:59:59.999Z'),
            ignoreCache: false,
            groupBy: 'day',
          },
        ],
      ])
      // The decorator calls the method it wraps on the prototype.
      expect(estimation.mock.contexts).toEqual([App.prototype])
      expect(namesOf(estimates)).toEqual([
        ['2026-11-01', ['AWS cached']],
        ['2026-11-02', ['AWS new']],
        ['2026-11-03', ['AWS new']],
      ])
      expect(await readCache()).toEqual(
        cacheText([
          cached()[0],
          dayOf('2026-11-02', [rowOf('AWS', 'new')]),
          dayOf('2026-11-03', [rowOf('AWS', 'new')]),
        ]),
      )
    })

    it('answers from the cache and never estimates a cached period again, provisional or not', async () => {
      await seedCache(cached())
      const replace = jest.spyOn(
        LocalCacheManager.prototype,
        'replaceEstimates',
      )

      const estimates = await new App().getCostAndEstimates(request)

      expect(estimation).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      expect(namesOf(estimates)).toEqual([
        ['2026-11-01', ['AWS cached']],
        ['2026-11-02', ['AWS cached', 'GCP cached']],
        ['2026-11-03', ['AWS cached']],
      ])
      expect(estimates[1].serviceEstimates[0].provenance.isProvisional).toBe(
        true,
      )
      expect(await readCache()).toEqual(cacheText(cached()))
    })
  })

  describe('refreshEstimates', () => {
    const november = {
      startDate: new Date('2026-11-01'),
      endDate: new Date('2026-11-30'),
      groupBy: GroupBy.day,
    }

    it('estimates the provisional periods again without the cache and replaces them in the cache file', async () => {
      await seedCache(cached())
      estimationReturns('2026-11-02', '2026-11-03')
      const getMissingDates = jest.spyOn(
        LocalCacheManager.prototype,
        'getMissingDates',
      )
      const setEstimates = jest.spyOn(
        LocalCacheManager.prototype,
        'setEstimates',
      )

      const summary = await new App().refreshEstimates(november)

      expect(estimation.mock.calls).toEqual([
        [
          {
            startDate: new Date('2026-11-02T00:00:00.000Z'),
            endDate: new Date('2026-11-03T23:59:59.999Z'),
            ignoreCache: true,
            groupBy: 'day',
          },
        ],
      ])
      // The cache of getCostAndEstimates is not asked or told anything.
      expect(getMissingDates).not.toHaveBeenCalled()
      expect(setEstimates).not.toHaveBeenCalled()
      expect(await readCache()).toEqual(
        cacheText([
          cached()[0],
          dayOf('2026-11-02', [rowOf('GCP', 'cached'), rowOf('AWS', 'new')]),
          dayOf('2026-11-03', [rowOf('AWS', 'new')]),
        ]),
      )
      expect(await readdir(directory)).toEqual(['estimates.cache.day.json'])
      expect(summary).toEqual({
        groupBy: 'day',
        cache: `file ${cacheFile}`,
        cachedPeriods: 3,
        provisionalBefore: 2,
        runs: 1,
        refreshedPeriods: 2,
        emptyPeriods: 0,
        keptBecauseWorse: 0,
        provisionalAfter: 0,
        failedRuns: [],
      })
    })

    it('is what the next footprint request is answered from', async () => {
      await seedCache(cached())
      estimationReturns('2026-11-02', '2026-11-03')
      const app = new App()
      await app.refreshEstimates(november)
      estimation.mockClear()

      const estimates = await app.getCostAndEstimates({
        startDate: new Date('2026-11-01'),
        endDate: new Date('2026-11-03'),
        ignoreCache: false,
        groupBy: 'day',
      })

      expect(estimation).not.toHaveBeenCalled()
      expect(namesOf(estimates)).toEqual([
        ['2026-11-01', ['AWS cached']],
        ['2026-11-02', ['GCP cached', 'AWS new']],
        ['2026-11-03', ['AWS new']],
      ])
    })

    it('leaves the cache file as it is when the estimation fails, and says so in the summary', async () => {
      await seedCache(cached())
      estimation.mockRejectedValue(new Error('The billing query failed'))

      const summary = await new App().refreshEstimates(november)

      expect(await readCache()).toEqual(cacheText(cached()))
      expect(summary).toMatchObject({
        refreshedPeriods: 0,
        provisionalAfter: 2,
        failedRuns: [{ periods: 2, error: 'The billing query failed' }],
      })
    })

    it('does nothing, and creates no cache file, when there is no cache', async () => {
      const summary = await new App().refreshEstimates(november)

      expect(estimation).not.toHaveBeenCalled()
      expect(await readdir(directory)).toEqual([])
      expect(summary).toEqual({
        groupBy: 'day',
        cache: `file ${cacheFile}`,
        cachedPeriods: 0,
        provisionalBefore: 0,
        runs: 0,
        refreshedPeriods: 0,
        emptyPeriods: 0,
        keptBecauseWorse: 0,
        provisionalAfter: 0,
        failedRuns: [],
      })
    })
  })

  describe('getCachedPeriodCounts', () => {
    it('counts the cached periods of each grouping and the provisional ones among them', async () => {
      await seedCache(cached())

      expect(await new App().getCachedPeriodCounts()).toEqual([
        { groupBy: 'day', cachedPeriods: 3, provisionalPeriods: 2 },
      ])
    })
  })
})
