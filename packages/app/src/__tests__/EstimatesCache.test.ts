/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  configLoader,
  EstimationResult,
  GroupBy,
  ServiceData,
  setConfig,
} from '@cloud-carbon-footprint/common'
import CacheManager, { CachedPeriod } from '../CacheManager'
import { countCachedPeriods, createCacheManager } from '../EstimatesCache'
import GoogleCloudCacheManager from '../GoogleCloudCacheManager'
import LocalCacheManager from '../LocalCacheManager'
import MongoDbCacheManager from '../MongoDbCacheManager'

const period = (date: string, isProvisional = false): CachedPeriod => ({
  timestamp: new Date(date),
  isProvisional,
  worstTiers: [],
})

/** A cache that holds the given periods for each grouping. */
const cacheWith = (periods: { [grouping: string]: CachedPeriod[] }) => {
  const getCachedPeriods = jest.fn(
    async (grouping: string) => periods[grouping] ?? [],
  )
  return {
    getCachedPeriods,
    cacheManager: { getCachedPeriods } as unknown as CacheManager,
  }
}

describe('createCacheManager', () => {
  afterEach(() => {
    setConfig()
  })

  it.each([
    ['GCS', GoogleCloudCacheManager],
    ['MONGODB', MongoDbCacheManager],
    ['LOCAL', LocalCacheManager],
    ['', LocalCacheManager],
    ['something else', LocalCacheManager],
  ])(
    'gives the manager that the decorator uses when CACHE_MODE is "%s"',
    (cacheMode, manager) => {
      setConfig({ ...configLoader(), CACHE_MODE: cacheMode })

      expect(createCacheManager()).toBeInstanceOf(manager)
    },
  )
})

describe('countCachedPeriods', () => {
  it('counts the periods of each grouping and how many of them hold provisional rows', async () => {
    const { cacheManager } = cacheWith({
      day: [
        period('2026-11-01'),
        period('2026-11-02', true),
        period('2026-11-03', true),
      ],
      month: [period('2026-10-01')],
    })

    expect(await countCachedPeriods(cacheManager)).toEqual([
      { groupBy: 'day', cachedPeriods: 3, provisionalPeriods: 2 },
      { groupBy: 'month', cachedPeriods: 1, provisionalPeriods: 0 },
    ])
  })

  it('asks for every period of each grouping, one grouping at a time', async () => {
    const { cacheManager, getCachedPeriods } = cacheWith({})

    await countCachedPeriods(cacheManager)

    expect(getCachedPeriods.mock.calls).toEqual(
      Object.values(GroupBy).map((grouping) => [grouping]),
    )
  })

  it('has nothing to say when nothing is cached', async () => {
    expect(await countCachedPeriods(cacheWith({}).cacheManager)).toEqual([])
  })

  it('fails when the cache cannot be read', async () => {
    const cacheManager = {
      getCachedPeriods: jest
        .fn()
        .mockRejectedValue(new Error('the read failed')),
    } as unknown as CacheManager

    await expect(countCachedPeriods(cacheManager)).rejects.toThrow(
      'the read failed',
    )
  })

  describe('with the configured cache', () => {
    const saved: Record<string, string | undefined> = {}
    let directory: string

    const row = (isProvisional: boolean): ServiceData => ({
      cloudProvider: 'AWS',
      kilowattHours: 1,
      co2e: 1,
      cost: 1,
      accountId: 'account',
      accountName: 'account',
      serviceName: 'service',
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

    const cacheText = (
      grouping: GroupBy,
      periods: [string, boolean][],
    ): string =>
      '[\n' +
      periods
        .map(([date, isProvisional]) =>
          JSON.stringify({
            timestamp: new Date(date),
            serviceEstimates: [row(isProvisional)],
            groupBy: grouping,
          } as EstimationResult),
        )
        .join('\n,\n') +
      '\n]'

    beforeEach(async () => {
      for (const name of ['CCF_CACHE_PATH', 'TEST_MODE', 'CACHE_MODE']) {
        saved[name] = process.env[name]
        delete process.env[name]
      }
      directory = await mkdtemp(join(tmpdir(), 'estimates-cache-'))
      process.env.CCF_CACHE_PATH = join(directory, 'estimates.cache')
      setConfig()
    })

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true })
      for (const name of Object.keys(saved)) {
        if (saved[name] === undefined) delete process.env[name]
        else process.env[name] = saved[name]
      }
      setConfig()
    })

    it('reads the local cache files, changes none and creates none', async () => {
      const days = cacheText(GroupBy.day, [
        ['2026-11-01', false],
        ['2026-11-02', true],
      ])
      const months = cacheText(GroupBy.month, [['2026-10-01', true]])
      await writeFile(join(directory, 'estimates.cache.day.json'), days)
      await writeFile(join(directory, 'estimates.cache.month.json'), months)
      // A grouping that was asked for once and holds nothing.
      await writeFile(join(directory, 'estimates.cache.year.json'), '[]')

      expect(await countCachedPeriods()).toEqual([
        { groupBy: 'day', cachedPeriods: 2, provisionalPeriods: 1 },
        { groupBy: 'month', cachedPeriods: 1, provisionalPeriods: 1 },
      ])

      expect((await readdir(directory)).sort()).toEqual([
        'estimates.cache.day.json',
        'estimates.cache.month.json',
        'estimates.cache.year.json',
      ])
      expect(
        await readFile(join(directory, 'estimates.cache.day.json'), 'utf8'),
      ).toEqual(days)
    })

    it('has nothing to say, and creates no file, when there is no cache', async () => {
      expect(await countCachedPeriods()).toEqual([])

      expect(await readdir(directory)).toEqual([])
    })
  })
})
