/*
 * © 2021 Thoughtworks, Inc.
 */
import moment from 'moment'
import { PassThrough } from 'stream'
import { Writable } from 'stream'
import {
  EstimationResult,
  GroupBy,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import GoogleCloudCacheManager from '../GoogleCloudCacheManager'
import { EstimationRequest } from '../CreateValidRequest'

const creatReadStreamMock = jest.fn()
const createWriteStreamMock = jest.fn()
const writeGcsFile = jest.fn()
const existsMock = jest.fn()

jest.mock('@google-cloud/storage', () => {
  return {
    Storage: jest.fn().mockImplementation(() => {
      return {
        bucket: jest.fn().mockImplementation(() => {
          return {
            file: jest.fn().mockImplementation(() => {
              return {
                createReadStream: creatReadStreamMock,
                createWriteStream: createWriteStreamMock,
                save: writeGcsFile,
                exists: existsMock,
              }
            }),
          }
        }),
      }
    }),
  }
})

const mockWriteToFile = jest.fn()
jest.mock('../common/helpers', () => ({
  ...(jest.requireActual('../common/helpers') as Record<string, unknown>),
  writeToFile: (...args: unknown[]) => mockWriteToFile(...args),
}))

jest.mock('@cloud-carbon-footprint/common', () => ({
  ...(jest.requireActual('@cloud-carbon-footprint/common') as Record<
    string,
    unknown
  >),
  Logger: jest.fn().mockImplementation(() => {
    return {
      info: jest.fn(),
    }
  }),
  cache: jest.fn(),
  configLoader: jest.fn().mockImplementation(() => {
    return {
      GCP: {
        CACHE_BUCKET_NAME: 'test-bucket-name',
      },
      CACHE_MODE: 'GCS',
    }
  }),
}))

const buildFootprintEstimates = (
  startDate: string,
  consecutiveDays: number,
) => {
  const grouping = 'day' as GroupBy
  return [...Array(consecutiveDays)].map((v, i) => {
    const timestamp = moment.utc(startDate).add(i, 'days').toDate()
    return {
      timestamp,
      serviceEstimates: [],
      periodStartDate: undefined,
      periodEndDate: undefined,
      groupBy: grouping,
    }
  })
}

describe('CacheManager', () => {
  let googleCloudCacheManager: GoogleCloudCacheManager

  beforeEach(() => {
    console.warn = jest.fn()
    googleCloudCacheManager = new GoogleCloudCacheManager()
  })

  const originalWarn = console.warn
  afterEach(() => {
    console.warn = originalWarn
    jest.clearAllMocks()
  })

  const buildFootprintJSONEstimates = (startDate: string) => {
    return JSON.stringify(buildFootprintEstimates(startDate, 1))
      .replace(/^\[/, '[\n')
      .replace(/]$/, '\n]')
  }

  describe('getEstimates', () => {
    it('should get estimates', async () => {
      //setup
      const cachedEstimates = buildFootprintEstimates('2020-01-01', 1)

      googleCloudCacheManager.cachedEstimates = cachedEstimates

      const estimates = await googleCloudCacheManager.getEstimates()

      //assert
      expect(estimates).toEqual(cachedEstimates)
    })

    it('should console.warn on file writing error', async () => {
      //setup
      const startDate = '2020-10-01'
      const endDate = '2020-10-02'

      const mockedStream = new PassThrough()
      mockedStream.push(JSON.stringify(buildFootprintEstimates(startDate, 1)))
      mockedStream.end()

      creatReadStreamMock.mockRejectedValue('ERROR')

      console.warn = jest.fn()

      //run
      const request: EstimationRequest = {
        startDate: moment.utc(startDate).toDate(),
        endDate: moment.utc(endDate).toDate(),
        ignoreCache: false,
      }
      await googleCloudCacheManager.getMissingDates(request, 'day')

      //assert
      expect(console.warn).toHaveBeenCalled()
    })
  })

  describe('setEstimates', () => {
    it('should set estimates to GCS File', async () => {
      //setup
      const startDate = '2020-10-01'
      const cachedData: EstimationResult[] = buildFootprintEstimates(
        startDate,
        1,
      )
      const mockWriteStream = {
        write: jest
          .fn()
          .mockImplementation((_data: string, cb?: () => void) => {
            if (cb) cb()
            return true
          }),
        end: jest.fn().mockImplementation((cb?: () => void) => {
          if (cb) cb()
          return Promise.resolve()
        }),
        on: jest.fn(),
      }
      mockWriteToFile.mockResolvedValue(undefined)
      createWriteStreamMock.mockResolvedValue(mockWriteStream)

      //run
      await googleCloudCacheManager.setEstimates(cachedData, 'day')

      //assert
      expect(createWriteStreamMock).toHaveBeenCalled()
      expect(mockWriteToFile).toHaveBeenCalledWith(mockWriteStream, cachedData)
      expect(mockWriteStream.end).toHaveBeenCalled()
    })

    it('should console.warn on file writing error', async () => {
      //setup
      const startDate = '2020-10-01'
      const cachedData: EstimationResult[] = buildFootprintEstimates(
        startDate,
        1,
      )
      const mockWriteStream = {
        write: jest.fn().mockReturnValue(true),
        end: jest.fn(),
        on: jest.fn(),
      }
      createWriteStreamMock.mockResolvedValue(mockWriteStream)
      mockWriteToFile.mockRejectedValue(new Error('ERROR'))

      console.warn = jest.fn()

      //run
      await googleCloudCacheManager.setEstimates(cachedData, 'day')

      //assert
      expect(console.warn).toHaveBeenCalled()
    })
  })

  it('gets missing dates', async () => {
    const request: EstimationRequest = {
      startDate: new Date('2022-01-01'),
      endDate: new Date('2022-01-03'),
      ignoreCache: false,
      groupBy: 'day',
    }

    const mockedStream = new PassThrough()
    const jsonString = buildFootprintJSONEstimates('2022-01-01')
    const estimates = buildFootprintEstimates('2022-01-01', 1)

    mockedStream.push(jsonString)
    mockedStream.end()

    creatReadStreamMock.mockReturnValue(mockedStream)
    existsMock.mockReturnValue([true])

    const missingDates = await googleCloudCacheManager.getMissingDates(
      request,
      'day',
    )

    expect(googleCloudCacheManager.cachedEstimates).toEqual(estimates)
    expect(JSON.stringify(missingDates)).toEqual(
      JSON.stringify([
        moment.utc(new Date('2022-01-02')),
        moment.utc(new Date('2022-01-03')),
      ]),
    )
  })

  const rowOf = (
    cloudProvider: string,
    serviceName: string,
    isProvisional = false,
  ): ServiceData => ({
    cloudProvider,
    kilowattHours: 1,
    co2e: 1,
    cost: 1,
    accountId: 'account',
    accountName: 'account',
    serviceName,
    region: 'region',
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
    periodEndDate: new Date(`${date}T23:59:59.000Z`),
    groupBy: GroupBy.day,
  })

  /** A cached period whose rows, of the given providers, are all of tier B. */
  const periodOf = (
    date: string,
    isProvisional: boolean,
    ...cloudProviders: string[]
  ) => ({
    timestamp: new Date(date),
    isProvisional,
    worstTiers: cloudProviders.map((cloudProvider) => ({
      cloudProvider,
      region: 'region',
      qualityTier: 'B',
    })),
  })

  /** The text of a cache object: a JSON array with one estimation result per line. */
  const cacheText = (estimates: EstimationResult[]) =>
    '[\n' + estimates.map((e) => JSON.stringify(e)).join('\n,\n') + '\n]'

  /** The cache object, as the bucket answers a read of it. */
  const cacheObjectWith = (text: string) => {
    const stream = new PassThrough()
    stream.end(text)
    existsMock.mockReturnValue([true])
    creatReadStreamMock.mockReturnValue(stream)
  }

  /** An upload that keeps what is written to it. */
  const upload = () => {
    const chunks: string[] = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString())
        callback()
      },
    })
    createWriteStreamMock.mockReturnValue(stream)
    return { stream, text: () => chunks.join('') }
  }

  /** The real writer of cache files, which the tests above replace. */
  const writeForReal = () =>
    mockWriteToFile.mockImplementation(
      jest.requireActual('../common/helpers').writeToFile,
    )

  /** Forgets what a test told the bucket and the writer to do. */
  const resetBucket = () =>
    [
      existsMock,
      creatReadStreamMock,
      createWriteStreamMock,
      writeGcsFile,
      mockWriteToFile,
    ].forEach((mock) => mock.mockReset())

  const cached = () => [
    dayOf('2026-11-01', [rowOf('AWS', 'aws-1'), rowOf('GCP', 'gcp-1')]),
    dayOf('2026-11-02', [rowOf('AWS', 'aws-2', true), rowOf('GCP', 'gcp-2')]),
    dayOf('2026-11-03', [rowOf('AWS', 'aws-3')]),
  ]

  describe('setEstimates with a date that is already cached', () => {
    afterEach(resetBucket)

    it('writes the date once, with the new result and not the cached one', async () => {
      const [first, second, third] = cached()
      googleCloudCacheManager.cachedEstimates = [first, second, third]
      const newSecond = dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])
      const uploaded = upload()
      writeForReal()

      await googleCloudCacheManager.setEstimates([newSecond], 'day')

      expect(uploaded.text()).toEqual(cacheText([first, third, newSecond]))
    })

    it('still adds a date that is not cached', async () => {
      googleCloudCacheManager.cachedEstimates = cached()
      const fourth = dayOf('2026-11-04', [rowOf('AWS', 'aws-4')])
      const uploaded = upload()
      writeForReal()

      await googleCloudCacheManager.setEstimates([fourth], 'day')

      expect(uploaded.text()).toEqual(cacheText([...cached(), fourth]))
    })

    it('writes the cached results and then the new ones, as it did before, also when the new ones are earlier', async () => {
      const [first, second, third] = cached()
      googleCloudCacheManager.cachedEstimates = [second, third]
      const uploaded = upload()
      writeForReal()

      await googleCloudCacheManager.setEstimates([first], 'day')

      expect(uploaded.text()).toEqual(cacheText([second, third, first]))
    })
  })

  describe('replaceEstimates', () => {
    afterEach(resetBucket)

    const newEstimates = () => [
      dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')]),
    ]

    it('rewrites the object with the new rows in place of the rows of the given providers', async () => {
      const [first, , third] = cached()
      cacheObjectWith(cacheText(cached()))
      const uploaded = upload()
      writeForReal()

      await googleCloudCacheManager.replaceEstimates(newEstimates(), 'day', [
        'aws',
      ])

      expect(uploaded.text()).toEqual(
        cacheText([
          first,
          dayOf('2026-11-02', [
            rowOf('GCP', 'gcp-2'),
            rowOf('AWS', 'new-aws-2'),
          ]),
          third,
        ]),
      )
      expect(uploaded.stream.writableFinished).toBe(true)
      // It is not one of the two things the decorator reads back.
      expect(googleCloudCacheManager.fetchedEstimates).toEqual([])
    })

    it('replaces every row of the periods when no providers are given', async () => {
      const [first, , third] = cached()
      cacheObjectWith(cacheText(cached()))
      const uploaded = upload()
      writeForReal()

      await googleCloudCacheManager.replaceEstimates(newEstimates(), 'day')

      expect(uploaded.text()).toEqual(
        cacheText([first, ...newEstimates(), third]),
      )
    })

    it('writes the object when there is none, and reads nothing', async () => {
      existsMock.mockReturnValue([false])
      const uploaded = upload()
      writeForReal()

      await googleCloudCacheManager.replaceEstimates(newEstimates(), 'day', [
        'AWS',
      ])

      expect(uploaded.text()).toEqual(cacheText(newEstimates()))
      expect(creatReadStreamMock).not.toHaveBeenCalled()
      expect(writeGcsFile).not.toHaveBeenCalled()
    })

    it('does nothing when there are no estimates', async () => {
      await googleCloudCacheManager.replaceEstimates([], 'day', ['AWS'])

      expect(existsMock).not.toHaveBeenCalled()
      expect(createWriteStreamMock).not.toHaveBeenCalled()
    })

    it('ends only when the upload has ended', async () => {
      cacheObjectWith(cacheText(cached()))
      writeForReal()
      let endUpload: () => void
      // Settles once everything has been handed to the upload, which then
      // waits for this test to end it.
      const handedOver = new Promise<void>((resolve) => {
        createWriteStreamMock.mockReturnValue(
          new Writable({
            write: (_chunk, _encoding, callback) => callback(),
            final: (callback) => {
              endUpload = callback
              resolve()
            },
          }),
        )
      })
      let ended = false

      const replacing = googleCloudCacheManager
        .replaceEstimates(newEstimates(), 'day', ['AWS'])
        .then(() => {
          ended = true
        })
      await handedOver
      // One turn of the event loop: a replace that did not wait for the
      // upload would have ended by now.
      await new Promise((resolve) => setImmediate(resolve))

      expect(ended).toBe(false)
      endUpload()
      await replacing
      expect(ended).toBe(true)
    })

    it('fails when the upload fails', async () => {
      cacheObjectWith(cacheText(cached()))
      writeForReal()
      createWriteStreamMock.mockReturnValue(
        new Writable({
          write: (_chunk, _encoding, callback) =>
            callback(new Error('the upload failed')),
        }),
      )

      await expect(
        googleCloudCacheManager.replaceEstimates(newEstimates(), 'day', [
          'AWS',
        ]),
      ).rejects.toThrow('the upload failed')
    })

    it('fails and gives the upload up when a row cannot be written', async () => {
      cacheObjectWith(cacheText(cached()))
      const uploaded = upload()
      writeForReal()
      const unwritable = { ...rowOf('AWS', 'new-aws-2'), cost: BigInt(1) }

      await expect(
        googleCloudCacheManager.replaceEstimates(
          [dayOf('2026-11-02', [unwritable as unknown as ServiceData])],
          'day',
          ['AWS'],
        ),
      ).rejects.toThrow(/BigInt/)

      expect(uploaded.stream.destroyed).toBe(true)
      expect(uploaded.stream.writableFinished).toBe(false)
    })

    it('fails and uploads nothing when the object cannot be read', async () => {
      const failing = new PassThrough()
      existsMock.mockReturnValue([true])
      creatReadStreamMock.mockReturnValue(failing)
      setImmediate(() => failing.destroy(new Error('the read failed')))

      await expect(
        googleCloudCacheManager.replaceEstimates(newEstimates(), 'day', [
          'AWS',
        ]),
      ).rejects.toThrow('the read failed')

      expect(createWriteStreamMock).not.toHaveBeenCalled()
    })

    it('fails and uploads nothing when the object cannot be parsed', async () => {
      cacheObjectWith(cacheText(cached()).slice(0, -40))

      await expect(
        googleCloudCacheManager.replaceEstimates(newEstimates(), 'day', [
          'AWS',
        ]),
      ).rejects.toThrow(SyntaxError)

      expect(createWriteStreamMock).not.toHaveBeenCalled()
    })

    it('fails when the bucket cannot be asked for the object', async () => {
      existsMock.mockRejectedValue(new Error('no access to the bucket'))

      await expect(
        googleCloudCacheManager.replaceEstimates(newEstimates(), 'day', [
          'AWS',
        ]),
      ).rejects.toThrow('no access to the bucket')

      expect(createWriteStreamMock).not.toHaveBeenCalled()
    })
  })

  describe('getCachedPeriods', () => {
    afterEach(resetBucket)

    it('lists the periods of the object and marks the ones that hold a provisional row', async () => {
      cacheObjectWith(cacheText(cached()))

      expect(await googleCloudCacheManager.getCachedPeriods('day')).toEqual([
        periodOf('2026-11-01', false, 'AWS', 'GCP'),
        periodOf('2026-11-02', true, 'AWS', 'GCP'),
        periodOf('2026-11-03', false, 'AWS'),
      ])
    })

    it('lists only the periods whose timestamp lies in the range', async () => {
      cacheObjectWith(cacheText(cached()))

      expect(
        await googleCloudCacheManager.getCachedPeriods('day', {
          startDate: new Date('2026-11-02'),
          endDate: new Date('2026-11-03'),
        }),
      ).toEqual([
        periodOf('2026-11-02', true, 'AWS', 'GCP'),
        periodOf('2026-11-03', false, 'AWS'),
      ])
    })

    it('has no periods for a cache object that was created and holds nothing yet', async () => {
      // What getMissingDates saves when it finds no cache object.
      cacheObjectWith('[]')

      expect(await googleCloudCacheManager.getCachedPeriods('day')).toEqual([])
    })

    it('has no periods, and creates no object, when there is no cache object', async () => {
      existsMock.mockReturnValue([false])

      expect(await googleCloudCacheManager.getCachedPeriods('day')).toEqual([])

      expect(creatReadStreamMock).not.toHaveBeenCalled()
      expect(writeGcsFile).not.toHaveBeenCalled()
    })

    it('fails when the object cannot be read', async () => {
      existsMock.mockRejectedValue(new Error('no access to the bucket'))

      await expect(
        googleCloudCacheManager.getCachedPeriods('day'),
      ).rejects.toThrow('no access to the bucket')
    })
  })

  it('says where the cache object of a grouping is', () => {
    expect(googleCloudCacheManager.locationOf('month')).toBe(
      'gs://test-bucket-name/estimates.cache.month.json',
    )
  })
})
