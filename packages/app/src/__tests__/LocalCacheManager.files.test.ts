/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * LocalCacheManager against real files in a temporary directory. The other
 * tests of the manager replace the file system with mocks; these check what
 * is in the cache file, and next to it, after a write.
 */

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  EstimationResult,
  GroupBy,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import { CachedPeriod } from '../CacheManager'
import LocalCacheManager from '../LocalCacheManager'
import { EstimationRequest } from '../CreateValidRequest'

const rowOf = (
  cloudProvider: string,
  serviceName: string,
  isProvisional = false,
): ServiceData => ({
  cloudProvider,
  kilowattHours: 0.0123456789012,
  co2e: 0.00000412345678901,
  cost: 1.23456789,
  usesAverageCPUConstant: false,
  accountId: '123456789012',
  accountName: '123456789012',
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
    gCO2ePerKWh: 123.4,
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
  periodEndDate: new Date(`${date}T23:59:59.000Z`),
  groupBy: GroupBy.day,
})

/** The text of a cache file: a JSON array with one estimation result per line. */
const cacheText = (estimates: EstimationResult[]) =>
  '[\n' + estimates.map((e) => JSON.stringify(e)).join('\n,\n') + '\n]'

/** A cached period whose rows, of the given providers, are all of tier B. */
const periodOf = (
  date: string,
  isProvisional: boolean,
  ...cloudProviders: string[]
): CachedPeriod => ({
  timestamp: new Date(date),
  isProvisional,
  worstTiers: cloudProviders.map((cloudProvider) => ({
    cloudProvider,
    region: 'eu-west-2',
    qualityTier: 'B',
  })),
})

describe('LocalCacheManager with real files', () => {
  const saved: Record<string, string | undefined> = {}
  let directory: string
  let cacheFile: string
  let cacheManager: LocalCacheManager

  const seedCache = (estimates: EstimationResult[]) =>
    writeFile(cacheFile, cacheText(estimates), 'utf8')
  const readCache = () => readFile(cacheFile, 'utf8')

  const cached = () => [
    dayOf('2026-11-01', [rowOf('AWS', 'aws-1'), rowOf('GCP', 'gcp-1')]),
    dayOf('2026-11-02', [
      rowOf('AWS', 'aws-2', true),
      rowOf('AWS', 'aws-2b'),
      rowOf('GCP', 'gcp-2'),
    ]),
    dayOf('2026-11-03', [rowOf('AWS', 'aws-3')]),
  ]

  beforeEach(async () => {
    for (const name of ['CCF_CACHE_PATH', 'TEST_MODE']) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    directory = await mkdtemp(join(tmpdir(), 'estimates-cache-'))
    process.env.CCF_CACHE_PATH = join(directory, 'estimates.cache')
    cacheFile = join(directory, 'estimates.cache.day.json')
    cacheManager = new LocalCacheManager()
    jest.spyOn(console, 'warn').mockImplementation()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  describe('replacing estimates', () => {
    it('puts the new rows in place of the rows of the given providers and leaves the rest of the file as it was', async () => {
      const [first, , third] = cached()
      await seedCache(cached())

      await cacheManager.replaceEstimates(
        [dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])],
        'day',
        ['aws'],
      )

      expect(await readCache()).toEqual(
        cacheText([
          first,
          dayOf('2026-11-02', [
            rowOf('GCP', 'gcp-2'),
            rowOf('AWS', 'new-aws-2'),
          ]),
          third,
        ]),
      )
      expect(await readdir(directory)).toEqual(['estimates.cache.day.json'])
    })

    it('replaces every row of the periods when no providers are given', async () => {
      const [first, , third] = cached()
      await seedCache(cached())
      const newDay = dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])

      await cacheManager.replaceEstimates([newDay], 'day')

      expect(await readCache()).toEqual(cacheText([first, newDay, third]))
    })

    it('adds a period that is not cached yet', async () => {
      await seedCache(cached())
      const newDay = dayOf('2026-10-31', [rowOf('AWS', 'new-aws-0')])

      await cacheManager.replaceEstimates([newDay], 'day', ['AWS'])

      expect(await readCache()).toEqual(cacheText([newDay, ...cached()]))
    })

    it('creates the cache file when there is none', async () => {
      const newDay = dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])

      await cacheManager.replaceEstimates([newDay], 'day', ['AWS'])

      expect(await readCache()).toEqual(cacheText([newDay]))
      expect(await readdir(directory)).toEqual(['estimates.cache.day.json'])
    })

    it('replaces rows in a cache file that CCF created and wrote to, which ends with an empty array', async () => {
      // A request for dates that no cache file holds creates the file, and
      // writing the estimates to it leaves "[]" as its last entry.
      const request: EstimationRequest = {
        startDate: new Date('2026-11-01'),
        endDate: new Date('2026-11-03'),
        ignoreCache: false,
        groupBy: 'day',
      }
      await cacheManager.getMissingDates(request, 'day')
      await cacheManager.setEstimates(cached(), 'day')
      expect(await readCache()).toEqual(
        cacheText(cached()).replace(/\n]$/, '\n,\n[]\n]'),
      )

      const newDay = dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])
      await cacheManager.replaceEstimates([newDay], 'day')

      const [first, , third] = cached()
      expect(await readCache()).toEqual(cacheText([first, newDay, third]))
      expect(await cacheManager.getCachedPeriods('day')).toEqual([
        periodOf('2026-11-01', false, 'AWS', 'GCP'),
        periodOf('2026-11-02', false, 'AWS'),
        periodOf('2026-11-03', false, 'AWS'),
      ])
    })

    it('is read back by the next request for the dates', async () => {
      await seedCache(cached())
      const newDay = dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])
      await cacheManager.replaceEstimates([newDay], 'day')

      const request: EstimationRequest = {
        startDate: new Date('2026-11-02'),
        endDate: new Date('2026-11-03'),
        ignoreCache: false,
        groupBy: 'day',
      }
      const reader = new LocalCacheManager()
      const missingDates = await reader.getMissingDates(request, 'day')
      const estimates = await reader.getEstimates()

      expect(missingDates).toEqual([])
      expect(
        estimates.map(({ timestamp, serviceEstimates }) => [
          timestamp,
          serviceEstimates,
        ]),
      ).toEqual([
        [newDay.timestamp, newDay.serviceEstimates],
        [new Date('2026-11-03'), cached()[2].serviceEstimates],
      ])
    })

    it('fails, and leaves the cache file and nothing else, when a new row cannot be written', async () => {
      await seedCache(cached())
      // JSON has no BigInt, so writing this row fails after the write began.
      const unwritable = { ...rowOf('AWS', 'new-aws-3'), cost: BigInt(1) }

      await expect(
        cacheManager.replaceEstimates(
          [
            dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')]),
            dayOf('2026-11-03', [unwritable as unknown as ServiceData]),
          ],
          'day',
          ['AWS'],
        ),
      ).rejects.toThrow(/BigInt/)

      expect(await readCache()).toEqual(cacheText(cached()))
      expect(await readdir(directory)).toEqual(['estimates.cache.day.json'])
    })

    it('fails, and leaves the cache file as it is, when the file cannot be parsed', async () => {
      const corrupt = cacheText(cached()).slice(0, -40)
      await writeFile(cacheFile, corrupt, 'utf8')

      await expect(
        cacheManager.replaceEstimates(
          [dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])],
          'day',
          ['AWS'],
        ),
      ).rejects.toThrow(SyntaxError)

      expect(await readCache()).toEqual(corrupt)
      expect(await readdir(directory)).toEqual(['estimates.cache.day.json'])
    })
  })

  describe('listing the cached periods', () => {
    it('lists the periods of the cache file and marks the ones that hold a provisional row', async () => {
      await seedCache(cached())

      expect(await cacheManager.getCachedPeriods('day')).toEqual([
        periodOf('2026-11-01', false, 'AWS', 'GCP'),
        periodOf('2026-11-02', true, 'AWS', 'GCP'),
        periodOf('2026-11-03', false, 'AWS'),
      ])
      expect(
        await cacheManager.getCachedPeriods('day', {
          startDate: new Date('2026-11-02'),
          endDate: new Date('2026-11-02'),
        }),
      ).toEqual([periodOf('2026-11-02', true, 'AWS', 'GCP')])
    })

    it('gives the worst quality tier of the rows of each provider and region', async () => {
      const tierC = rowOf('AWS', 'aws-1b')
      tierC.provenance.qualityTier = 'C'
      const { provenance: _none, ...withoutProvenance } = rowOf('GCP', 'gcp-1')
      await seedCache([
        dayOf('2026-11-01', [
          rowOf('AWS', 'aws-1'),
          tierC,
          { ...rowOf('AWS', 'aws-1c'), region: 'us-east-1' },
          withoutProvenance,
        ]),
      ])

      expect(await cacheManager.getCachedPeriods('day')).toEqual([
        {
          timestamp: new Date('2026-11-01'),
          isProvisional: false,
          worstTiers: [
            { cloudProvider: 'AWS', region: 'eu-west-2', qualityTier: 'C' },
            { cloudProvider: 'AWS', region: 'us-east-1', qualityTier: 'B' },
          ],
        },
      ])
    })

    it('has no periods, and creates no file, for a grouping that has no cache file', async () => {
      await seedCache(cached())

      expect(await cacheManager.getCachedPeriods('month')).toEqual([])

      expect(await readdir(directory)).toEqual(['estimates.cache.day.json'])
    })

    it('has no periods for a cache file that was created and holds nothing yet', async () => {
      await cacheManager.getMissingDates(
        {
          startDate: new Date('2026-11-01'),
          endDate: new Date('2026-11-01'),
          ignoreCache: false,
          groupBy: 'day',
        },
        'day',
      )
      expect(await readCache()).toEqual('[]')

      expect(await cacheManager.getCachedPeriods('day')).toEqual([])
    })

    it('fails when the cache file cannot be parsed', async () => {
      await writeFile(cacheFile, '[\n{"timestamp":"2026-11-01T00', 'utf8')

      await expect(cacheManager.getCachedPeriods('day')).rejects.toThrow(
        SyntaxError,
      )
    })
  })

  describe('setting estimates', () => {
    const request: EstimationRequest = {
      startDate: new Date('2026-11-03'),
      endDate: new Date('2026-11-04'),
      ignoreCache: false,
      groupBy: 'day',
    }

    it('adds the new dates to the cache file and leaves no temporary file', async () => {
      await seedCache(cached())
      const newDay = dayOf('2026-11-04', [rowOf('AWS', 'aws-4')])

      await cacheManager.getMissingDates(request, 'day')
      await cacheManager.setEstimates([newDay], 'day')

      expect(await readCache()).toEqual(cacheText([...cached(), newDay]))
      expect(await readdir(directory)).toEqual(['estimates.cache.day.json'])
      expect(console.warn).not.toHaveBeenCalled()
    })

    it('leaves the cache file whole, with a warning, when a write fails part way', async () => {
      await seedCache(cached())
      const unwritable = { ...rowOf('AWS', 'aws-4'), cost: BigInt(1) }

      await cacheManager.getMissingDates(request, 'day')
      await cacheManager.setEstimates(
        [dayOf('2026-11-04', [unwritable as unknown as ServiceData])],
        'day',
      )

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringMatching(/^Setting estimates error: .*BigInt/),
      )
      expect(await readCache()).toEqual(cacheText(cached()))
      expect(await readdir(directory)).toEqual(['estimates.cache.day.json'])
    })

    it('leaves nothing of the old file behind when the new one is shorter', async () => {
      // Writing in place left the end of the longer file after the new text.
      await seedCache(cached())
      const shorter = dayOf('2026-11-03', [])

      await cacheManager.getMissingDates(request, 'day')
      await cacheManager.setEstimates([shorter], 'day')

      const [first, second] = cached()
      expect(await readCache()).toEqual(cacheText([first, second, shorter]))
    })
  })

  describe('what a write keeps of the cache file, as writing it in place did', () => {
    const request: EstimationRequest = {
      startDate: new Date('2026-11-03'),
      endDate: new Date('2026-11-04'),
      ignoreCache: false,
      groupBy: 'day',
    }
    const newDay = dayOf('2026-11-04', [rowOf('AWS', 'aws-4')])
    const modeOf = async (file: string) => (await stat(file)).mode & 0o777

    it('keeps a mode that is narrower than the one new files get', async () => {
      await seedCache(cached())
      await chmod(cacheFile, 0o600)

      await cacheManager.getMissingDates(request, 'day')
      await cacheManager.setEstimates([newDay], 'day')

      expect(await readCache()).toEqual(cacheText([...cached(), newDay]))
      expect(await modeOf(cacheFile)).toEqual(0o600)
    })

    it('keeps a mode that is wider than the one new files get', async () => {
      await seedCache(cached())
      await chmod(cacheFile, 0o666)

      await cacheManager.replaceEstimates([newDay], 'day')

      expect(await readCache()).toEqual(cacheText([...cached(), newDay]))
      expect(await modeOf(cacheFile)).toEqual(0o666)
    })

    it('replaces the file that a symbolic link leads to, and leaves the link', async () => {
      const elsewhere = join(directory, 'elsewhere')
      const target = join(elsewhere, 'the-cache.json')
      await mkdir(elsewhere)
      await writeFile(target, cacheText(cached()), 'utf8')
      await chmod(target, 0o640)
      await symlink(target, cacheFile)

      await cacheManager.getMissingDates(request, 'day')
      await cacheManager.setEstimates([newDay], 'day')
      await cacheManager.replaceEstimates(
        [dayOf('2026-11-05', [rowOf('GCP', 'gcp-5')])],
        'day',
      )

      expect((await lstat(cacheFile)).isSymbolicLink()).toBe(true)
      expect(await readFile(target, 'utf8')).toEqual(
        cacheText([
          ...cached(),
          newDay,
          dayOf('2026-11-05', [rowOf('GCP', 'gcp-5')]),
        ]),
      )
      expect(await modeOf(target)).toEqual(0o640)
      expect(await readdir(elsewhere)).toEqual(['the-cache.json'])
      expect((await readdir(directory)).sort()).toEqual([
        'elsewhere',
        'estimates.cache.day.json',
      ])
      expect(console.warn).not.toHaveBeenCalled()
    })
  })
})
