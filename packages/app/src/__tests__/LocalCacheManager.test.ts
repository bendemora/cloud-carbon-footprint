/**
 * © 2021 Thoughtworks, Inc.
 */

import moment from 'moment'
import { promises, Stats } from 'fs'
import { FileHandle } from 'fs/promises'
import { resolve } from 'path'
import { env } from 'process'
import {
  EstimationResult,
  GroupBy,
  Logger,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import { getCachedData, readCachedData, writeToFile } from '../common/helpers'
import LocalCacheManager from '../LocalCacheManager'
import { EstimationRequest } from '../CreateValidRequest'

jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    promises: {
      access: jest.fn(),
      writeFile: jest.fn(),
      open: jest.fn(),
      rename: jest.fn(),
      rm: jest.fn(),
      lstat: jest.fn(),
      realpath: jest.fn(),
      stat: jest.fn(),
    },
  }
})

jest.mock('../common/helpers', () => {
  const requireActual = jest.requireActual('../common/helpers')
  return {
    ...requireActual,
    writeToFile: jest.fn(),
    getCachedData: jest.fn(),
    readCachedData: jest.fn(),
  }
})

const mockWrite = writeToFile as jest.Mock
const mockGetCachedData = getCachedData as jest.Mock
const mockReadCachedData = readCachedData as jest.Mock
const mockFs = promises as jest.Mocked<typeof promises>

const buildFootprintEstimates = (
  startDate: string,
  consecutiveDays: number,
) => {
  const grouping = 'day' as GroupBy
  return [...Array(consecutiveDays)].map((v, i) => {
    return {
      timestamp: moment.utc(startDate).add(i, 'days').toDate(),
      serviceEstimates: [],
      periodStartDate: undefined,
      periodEndDate: undefined,
      groupBy: grouping,
    }
  })
}

const rowOf = (cloudProvider: string, serviceName: string): ServiceData => ({
  cloudProvider,
  kilowattHours: 1,
  co2e: 1,
  cost: 1,
  accountId: 'account',
  accountName: 'account',
  serviceName,
  region: 'region',
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

// The cache file in test mode, and the temporary file written next to it.
const CACHE_FILE = 'mock-estimates.json'
const TEMPORARY_FILE =
  /^mock-estimates\.\d+-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp\.json$/

/** What the file system says of a file, as far as the cache manager asks. */
const fileOfMode = (mode: number, isSymbolicLink = false) =>
  ({ mode, isSymbolicLink: () => isSymbolicLink }) as unknown as Stats

type FSError = Error & { code: string }
const fsError = (code: string, message = code): FSError =>
  Object.assign(new Error(message), { code })

describe('Local Cache Manager', () => {
  let cacheManager: LocalCacheManager
  let fileHandle: { close: jest.Mock; chmod: jest.Mock }

  beforeEach(() => {
    cacheManager = new LocalCacheManager()
    jest.resetModules() // Most important - it clears the cache
    jest.resetAllMocks()
    env.TEST_MODE = 'true'
    console.warn = jest.fn()
    fileHandle = {
      close: jest.fn(),
      chmod: jest.fn().mockResolvedValue(undefined),
    }
    mockFs.open.mockResolvedValue(fileHandle as unknown as FileHandle)
    mockFs.rm.mockResolvedValue(undefined)
    // The cache file is a regular file that its owner may write and all may read.
    mockFs.lstat.mockResolvedValue(fileOfMode(0o100644))
  })

  /** The temporary file of the write, as the test's file system was asked to open it. */
  const openedFile = () => mockFs.open.mock.calls[0][0] as string

  it('gets estimates', async () => {
    const cachedEstimates = buildFootprintEstimates('2020-01-01', 1)

    cacheManager.cachedEstimates = cachedEstimates
    const estimates = await cacheManager.getEstimates()

    await expect(estimates).toEqual(cachedEstimates)
  })

  it('sets estimates', async () => {
    const estimates = buildFootprintEstimates('2020-01-01', 1)

    mockGetCachedData.mockResolvedValue([])

    await cacheManager.setEstimates(estimates, GroupBy.day)

    expect(cacheManager.fetchedEstimates).toEqual(estimates)
    expect(mockWrite).toHaveBeenCalledWith(
      expect.anything(),
      estimates,
      expect.anything(),
    )
  })

  describe('setting estimates through a temporary file', () => {
    it('writes the new estimates with the cached ones to a temporary file and renames it to the cache file', async () => {
      const cachedInFile = buildFootprintEstimates('2020-01-01', 2)
      const estimates = buildFootprintEstimates('2020-01-03', 1)
      mockGetCachedData.mockResolvedValue(cachedInFile)

      await cacheManager.setEstimates(estimates, GroupBy.day)

      expect(mockFs.open).toHaveBeenCalledTimes(1)
      expect(mockFs.open).toHaveBeenCalledWith(
        expect.stringMatching(TEMPORARY_FILE),
        'wx',
        0o644,
      )
      expect(mockWrite).toHaveBeenCalledWith(
        promises,
        [...cachedInFile, ...estimates],
        fileHandle,
      )
      expect(fileHandle.close).toHaveBeenCalledTimes(1)
      expect(mockFs.rename).toHaveBeenCalledWith(openedFile(), CACHE_FILE)
      // The file is closed before it takes the place of the cache file.
      expect(fileHandle.close.mock.invocationCallOrder[0]).toBeLessThan(
        mockFs.rename.mock.invocationCallOrder[0],
      )
      expect(mockFs.rm).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
    })

    it('leaves alone a cache file that has gone or may not be written, with a warning', async () => {
      mockFs.access.mockRejectedValue(
        fsError('ENOENT', "ENOENT: no such file or directory, access 'x'"),
      )

      await cacheManager.setEstimates(
        buildFootprintEstimates('2020-01-01', 1),
        GroupBy.day,
      )

      expect(console.warn).toHaveBeenCalledWith(
        "Setting estimates error: ENOENT: no such file or directory, access 'x'",
      )
      expect(mockFs.open).not.toHaveBeenCalled()
      expect(mockFs.rename).not.toHaveBeenCalled()
    })

    it('keeps the cache file and removes the temporary file when the write fails part way, with a warning', async () => {
      mockGetCachedData.mockResolvedValue([])
      mockWrite.mockRejectedValue(new Error('disk full'))

      await cacheManager.setEstimates(
        buildFootprintEstimates('2020-01-01', 1),
        GroupBy.day,
      )

      expect(console.warn).toHaveBeenCalledWith(
        'Setting estimates error: disk full',
      )
      expect(fileHandle.close).toHaveBeenCalledTimes(1)
      expect(mockFs.rename).not.toHaveBeenCalled()
      expect(mockFs.rm).toHaveBeenCalledWith(openedFile(), { force: true })
    })

    it('gives the temporary file the mode of the cache file before it writes to it', async () => {
      mockGetCachedData.mockResolvedValue([])
      mockFs.lstat.mockResolvedValue(fileOfMode(0o100660))

      await cacheManager.setEstimates(
        buildFootprintEstimates('2020-01-01', 1),
        GroupBy.day,
      )

      expect(mockFs.lstat).toHaveBeenCalledWith(CACHE_FILE)
      expect(mockFs.open).toHaveBeenCalledWith(
        expect.stringMatching(TEMPORARY_FILE),
        'wx',
        0o660,
      )
      expect(fileHandle.chmod).toHaveBeenCalledWith(0o660)
      expect(fileHandle.chmod.mock.invocationCallOrder[0]).toBeLessThan(
        mockWrite.mock.invocationCallOrder[0],
      )
    })

    it('writes all the same when the mode of the temporary file cannot be set', async () => {
      mockGetCachedData.mockResolvedValue([])
      fileHandle.chmod.mockRejectedValue(
        fsError('EPERM', 'operation not permitted'),
      )

      await cacheManager.setEstimates(
        buildFootprintEstimates('2020-01-01', 1),
        GroupBy.day,
      )

      expect(mockWrite).toHaveBeenCalledTimes(1)
      expect(mockFs.rename).toHaveBeenCalledWith(openedFile(), CACHE_FILE)
      expect(console.warn).not.toHaveBeenCalled()
    })

    it('replaces the file that the cache file leads to when it is a symbolic link', async () => {
      mockGetCachedData.mockResolvedValue([])
      mockFs.lstat.mockResolvedValue(fileOfMode(0o120777, true))
      mockFs.realpath.mockResolvedValue('/elsewhere/the-cache.json')
      mockFs.stat.mockResolvedValue(fileOfMode(0o100600))

      await cacheManager.setEstimates(
        buildFootprintEstimates('2020-01-01', 1),
        GroupBy.day,
      )

      expect(mockFs.realpath).toHaveBeenCalledWith(CACHE_FILE)
      expect(mockFs.stat).toHaveBeenCalledWith('/elsewhere/the-cache.json')
      expect(openedFile()).toMatch(
        /^\/elsewhere\/the-cache\.\d+-[0-9a-f-]{36}\.tmp\.json$/,
      )
      expect(mockFs.open).toHaveBeenCalledWith(openedFile(), 'wx', 0o600)
      expect(fileHandle.chmod).toHaveBeenCalledWith(0o600)
      expect(mockFs.rename).toHaveBeenCalledWith(
        openedFile(),
        '/elsewhere/the-cache.json',
      )
    })
  })

  describe('replacing estimates', () => {
    const cachedInFile = () => [
      dayOf('2026-11-01', [rowOf('AWS', 'aws-1'), rowOf('GCP', 'gcp-1')]),
      dayOf('2026-11-02', [rowOf('AWS', 'aws-2'), rowOf('GCP', 'gcp-2')]),
    ]
    const newEstimates = () => [
      dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')]),
    ]

    it('writes the cache with the new rows in place of the rows of the given providers, through a temporary file', async () => {
      const cached = cachedInFile()
      mockReadCachedData.mockResolvedValue(cached)

      await cacheManager.replaceEstimates(newEstimates(), 'day', ['AWS'])

      expect(mockFs.open).toHaveBeenCalledWith(
        expect.stringMatching(TEMPORARY_FILE),
        'wx',
        0o644,
      )
      expect(mockWrite).toHaveBeenCalledWith(
        promises,
        [
          cached[0],
          dayOf('2026-11-02', [
            rowOf('GCP', 'gcp-2'),
            rowOf('AWS', 'new-aws-2'),
          ]),
        ],
        fileHandle,
      )
      expect(mockFs.rename).toHaveBeenCalledWith(openedFile(), CACHE_FILE)
      expect(mockFs.rm).not.toHaveBeenCalled()
      // It is not one of the two things the decorator reads back.
      expect(cacheManager.fetchedEstimates).toEqual([])
      expect(cacheManager.cachedEstimates).toEqual([])
    })

    it('replaces every row of the periods when no providers are given', async () => {
      const cached = cachedInFile()
      mockReadCachedData.mockResolvedValue(cached)

      await cacheManager.replaceEstimates(newEstimates(), 'day')

      expect(mockWrite).toHaveBeenCalledWith(
        promises,
        [cached[0], ...newEstimates()],
        fileHandle,
      )
    })

    it('creates the cache file when there is none, with the mode that new files get', async () => {
      mockFs.access.mockRejectedValue(fsError('ENOENT'))
      mockFs.lstat.mockRejectedValue(fsError('ENOENT'))

      await cacheManager.replaceEstimates(newEstimates(), 'day', ['AWS'])

      expect(mockReadCachedData).not.toHaveBeenCalled()
      expect(mockFs.open).toHaveBeenCalledWith(
        expect.stringMatching(TEMPORARY_FILE),
        'wx',
        0o666,
      )
      expect(fileHandle.chmod).not.toHaveBeenCalled()
      expect(mockWrite).toHaveBeenCalledWith(
        promises,
        newEstimates(),
        fileHandle,
      )
      expect(mockFs.rename).toHaveBeenCalledWith(openedFile(), CACHE_FILE)
    })

    it('does nothing when there are no estimates', async () => {
      await cacheManager.replaceEstimates([], 'day', ['AWS'])

      expect(mockFs.access).not.toHaveBeenCalled()
      expect(mockFs.open).not.toHaveBeenCalled()
    })

    it('fails, keeps the cache file and removes the temporary file when the write fails part way', async () => {
      mockReadCachedData.mockResolvedValue(cachedInFile())
      mockWrite.mockRejectedValue(new Error('disk full'))

      await expect(
        cacheManager.replaceEstimates(newEstimates(), 'day', ['AWS']),
      ).rejects.toThrow('disk full')

      expect(fileHandle.close).toHaveBeenCalledTimes(1)
      expect(mockFs.rename).not.toHaveBeenCalled()
      expect(mockFs.rm).toHaveBeenCalledWith(openedFile(), { force: true })
    })

    it('fails and removes the temporary file when it cannot be renamed to the cache file', async () => {
      mockReadCachedData.mockResolvedValue(cachedInFile())
      mockFs.rename.mockRejectedValue(fsError('EBUSY', 'resource busy'))

      await expect(
        cacheManager.replaceEstimates(newEstimates(), 'day', ['AWS']),
      ).rejects.toThrow('resource busy')

      expect(mockFs.rm).toHaveBeenCalledWith(openedFile(), { force: true })
    })

    it('fails with the error of the write when the temporary file cannot be removed either', async () => {
      mockReadCachedData.mockResolvedValue(cachedInFile())
      mockWrite.mockRejectedValue(new Error('disk full'))
      mockFs.rm.mockRejectedValue(new Error('cannot remove'))

      await expect(
        cacheManager.replaceEstimates(newEstimates(), 'day', ['AWS']),
      ).rejects.toThrow('disk full')
    })

    it('fails and writes nothing when the temporary file cannot be created', async () => {
      mockReadCachedData.mockResolvedValue(cachedInFile())
      mockFs.open.mockRejectedValue(fsError('EACCES', 'permission denied'))

      await expect(
        cacheManager.replaceEstimates(newEstimates(), 'day', ['AWS']),
      ).rejects.toThrow('permission denied')

      expect(mockWrite).not.toHaveBeenCalled()
      expect(mockFs.rename).not.toHaveBeenCalled()
      // The temporary file is not this call's to remove.
      expect(mockFs.rm).not.toHaveBeenCalled()
    })

    it('fails and writes nothing when the cache file cannot be read', async () => {
      mockReadCachedData.mockRejectedValue(new SyntaxError('Unexpected token'))

      await expect(
        cacheManager.replaceEstimates(newEstimates(), 'day', ['AWS']),
      ).rejects.toThrow('Unexpected token')

      expect(mockFs.open).not.toHaveBeenCalled()
      expect(mockFs.rename).not.toHaveBeenCalled()
    })

    it('fails and writes nothing when the cache file may not be read and written', async () => {
      mockFs.access.mockRejectedValue(fsError('EACCES', 'permission denied'))

      await expect(
        cacheManager.replaceEstimates(newEstimates(), 'day', ['AWS']),
      ).rejects.toThrow('permission denied')

      const { R_OK, W_OK } = jest.requireActual('fs').constants
      expect(mockFs.access).toHaveBeenCalledWith(CACHE_FILE, R_OK | W_OK)
      expect(mockReadCachedData).not.toHaveBeenCalled()
      expect(mockFs.open).not.toHaveBeenCalled()
    })
  })

  describe('listing the cached periods', () => {
    it('reads the cache file and says which periods are in the range', async () => {
      mockReadCachedData.mockResolvedValue([
        dayOf('2026-11-01', [rowOf('AWS', 'aws-1')]),
        dayOf('2026-11-02', [rowOf('AWS', 'aws-2')]),
      ])

      const periods = await cacheManager.getCachedPeriods('day', {
        startDate: new Date('2026-11-02'),
        endDate: new Date('2026-11-30'),
      })

      expect(periods).toEqual([
        {
          timestamp: new Date('2026-11-02'),
          isProvisional: false,
          worstTiers: [],
        },
      ])
      const { R_OK } = jest.requireActual('fs').constants
      expect(mockFs.access).toHaveBeenCalledWith(CACHE_FILE, R_OK)
    })

    it('has no periods, and creates no file, when there is no cache file', async () => {
      mockFs.access.mockRejectedValue(fsError('ENOENT'))

      expect(await cacheManager.getCachedPeriods('day')).toEqual([])

      expect(mockFs.writeFile).not.toHaveBeenCalled()
      expect(mockFs.open).not.toHaveBeenCalled()
    })

    it('fails when the cache file cannot be read', async () => {
      mockReadCachedData.mockRejectedValue(new Error('the read failed'))

      await expect(cacheManager.getCachedPeriods('day')).rejects.toThrow(
        'the read failed',
      )
    })
  })

  it('says where the cache file of a grouping is', () => {
    expect(cacheManager.locationOf('day')).toBe(`file ${resolve(CACHE_FILE)}`)

    delete env.TEST_MODE
    expect(cacheManager.locationOf('week')).toBe(
      `file ${resolve('estimates.cache.week.json')}`,
    )
  })

  it('gets missing dates', async () => {
    const request: EstimationRequest = {
      startDate: new Date('2022-01-01'),
      endDate: new Date('2022-01-02'),
      ignoreCache: false,
      groupBy: 'day',
    }

    const estimates = buildFootprintEstimates('2022-01-01', 1)

    mockGetCachedData.mockReturnValue(estimates)

    const missingDates = await cacheManager.getMissingDates(request, 'day')

    expect(cacheManager.cachedEstimates).toEqual(estimates)
    expect(JSON.stringify(missingDates)).toEqual(
      JSON.stringify([moment.utc(request.endDate)]),
    )
  })

  it('will create a new empty file if fails to load cache', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    mockFs.access.mockImplementation(() => {
      // throw new error with error code ENOENT
      const error = new Error('failed to open cache') as FSError
      error.code = 'ENOENT'
      throw error
    })

    const loggerMessage = 'Cache file not found. Creating new cache file...'

    await cacheManager.getMissingDates({} as EstimationRequest, 'day')

    expect(Logger.prototype.warn).toHaveBeenCalledWith(loggerMessage)
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      'mock-estimates.json',
      '[]',
      'utf8',
    )
  })

  it('will ignore the cache if there is an error parsing the file', async () => {
    const parsingErrorMessage = 'Unexpected token ] in JSON at position 0' // Happens with a corrupted file
    jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    mockGetCachedData.mockImplementation(() => {
      throw new SyntaxError(parsingErrorMessage)
    })

    const loggerMessage =
      'There was an error parsing the cache file. Ignoring cache and fetching fresh estimates...'

    await cacheManager.getMissingDates({} as EstimationRequest, 'day')

    expect(Logger.prototype.warn).toHaveBeenCalledWith(loggerMessage)
  })
})
