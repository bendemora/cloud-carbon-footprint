/*
 * © 2021 Thoughtworks, Inc.
 */

import {
  getCachedData,
  writeToFile,
  getCacheFileName,
  getMissingDates,
  includeCloudProviders,
  mergeEstimates,
} from '../../common/helpers'
import { constants } from 'buffer'
import { FileHandle } from 'fs/promises'
import { Readable, Stream } from 'stream'
import {
  EstimationResult,
  GroupBy,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import { EstimationRequest } from '../../CreateValidRequest'
import moment from 'moment'

describe('common/helpers.ts', () => {
  it('reads cached data formatted with [] and newlines separators', async () => {
    const mockData = Readable.from([
      '[\n',
      '{"this": "that", "timestamp": "2020-01-01"}',
      '\n]',
    ])

    const cachedData = await getCachedData(mockData)

    const expectedData = [{ this: 'that', timestamp: new Date('2020-01-01') }]

    expect(cachedData).toEqual(expectedData)
  })

  it('writes cache file with correct separators', async () => {
    const dataToBeCached: EstimationResult[] = [
      {
        timestamp: new Date('2020-01-01'),
        serviceEstimates: [],
        periodStartDate: undefined,
        periodEndDate: undefined,
        groupBy: GroupBy.day,
      },
    ]

    // intercept file writing calls
    const writable = new Stream.Writable()
    let cachedData = ''
    writable._write = (chunk, encoding, next) => {
      cachedData += chunk.toString()
      next()
    }

    await writeToFile(writable, dataToBeCached)

    const expectedCachedString =
      '[\n{"timestamp":"2020-01-01T00:00:00.000Z","serviceEstimates":[],"groupBy":"day"}\n]'

    expect(cachedData).toEqual(expectedCachedString)
  })

  describe('writing cache windows', () => {
    const row = {
      cloudProvider: 'AWS',
      kilowattHours: 0.0123456789012,
      co2e: 0.00000412345678901,
      cost: 1.23456789,
      usesAverageCPUConstant: false,
      accountId: '123456789012',
      accountName: '123456789012',
      serviceName: 'AmazonEC2',
      region: 'us-east-1',
      provenance: {
        sourceId: 'static',
        zoneId: 'aws:us-east-1',
        granularity: 'year',
        basis: 'location-production',
        factorType: 'direct',
        isEstimated: false,
        licenceId: 'open-attribution',
        qualityTier: 'D',
        gCO2ePerKWh: 379.069,
        modelVersion: 'unversioned',
      },
    } as ServiceData

    const days = (count: number, serviceEstimates: ServiceData[]) =>
      Array.from({ length: count }, (_, index) => {
        const timestamp = moment.utc('2020-01-01').add(index, 'days').toDate()
        return {
          timestamp,
          serviceEstimates,
          periodStartDate: timestamp,
          periodEndDate: timestamp,
          groupBy: GroupBy.day,
        }
      })

    const recordingWritable = () => {
      const writes: string[] = []
      const writable = new Stream.Writable()
      writable._write = (chunk, encoding, next) => {
        writes.push(chunk.toString())
        next()
      }
      return { writable, writes }
    }

    const cacheText = (estimates: EstimationResult[]) =>
      '[\n' + estimates.map((e) => JSON.stringify(e)).join('\n,\n') + '\n]'

    it('writes windows of about the given size, one estimation result per line', async () => {
      const estimates = days(5, [row])
      const oneDay = JSON.stringify(estimates[0]).length
      const { writable, writes } = recordingWritable()

      await writeToFile(writable, estimates, undefined, 2 * oneDay)

      expect(writes.join('')).toEqual(cacheText(estimates))
      const windows = writes.filter((text) => text.startsWith('{'))
      expect(windows.map((text) => text.split('\n,\n').length)).toEqual([
        2, 2, 1,
      ])
    })

    it('writes an estimation result larger than the window in a window of its own', async () => {
      const estimates = days(3, [row, row])
      const { writable, writes } = recordingWritable()

      await writeToFile(writable, estimates, undefined, 10)

      expect(writes.join('')).toEqual(cacheText(estimates))
      const windows = writes.filter((text) => text.startsWith('{'))
      expect(windows).toEqual(estimates.map((e) => JSON.stringify(e)))
    })

    it('writes to a file handle when given one', async () => {
      const estimates = days(2, [row])
      const writes: string[] = []
      const fileHandle = {} as FileHandle
      const promises = {
        writeFile: jest.fn(async (fh: FileHandle, text: string) => {
          expect(fh).toBe(fileHandle)
          writes.push(text)
        }),
      }

      await writeToFile(promises, estimates, fileHandle)

      expect(writes.join('')).toEqual(cacheText(estimates))
    })

    it('writes a cache whose 100 estimation results are longer together than the longest string Node can hold', async () => {
      // About 5.4 million characters per day, so 100 days pass the limit.
      // Every day shares one array of one row object, so the test needs
      // little memory beyond the text of one window.
      const rowsPerDay = Math.ceil(
        constants.MAX_STRING_LENGTH / 100 / JSON.stringify(row).length,
      )
      const estimates = days(101, new Array(rowsPerDay).fill(row))
      const oneDay = JSON.stringify(estimates[0]).length
      let length = 0
      let largestWrite = 0
      const writable = new Stream.Writable()
      writable._write = (chunk, encoding, next) => {
        length += chunk.length
        largestWrite = Math.max(largestWrite, chunk.length)
        next()
      }

      await writeToFile(writable, estimates)

      expect(100 * oneDay).toBeGreaterThan(constants.MAX_STRING_LENGTH)
      expect(length).toEqual(2 + 101 * oneDay + 100 * 3 + 2)
      expect(largestWrite).toBeLessThan(constants.MAX_STRING_LENGTH / 10)
    }, 120000)
  })

  describe('getCacheFile', () => {
    const OLD_ENV = process.env
    beforeEach(() => {
      jest.resetModules() // Most important - it clears the cache
      process.env = { ...OLD_ENV } // Make a copy
    })

    afterAll(() => {
      process.env = OLD_ENV // Restore old environment
    })

    it('should use the default prefix if a hard-coded one is not provided', async () => {
      const cacheFile = getCacheFileName('day')
      expect(cacheFile).toEqual('estimates.cache.day.json')
    })

    it('should alter the hard-coded cache path if one is provided', async () => {
      process.env.CCF_CACHE_PATH = 'my-cache-file.json'
      const cacheFile = getCacheFileName('day')
      expect(cacheFile).toEqual('my-cache-file.day.json')
    })
  })

  it('gets missing dates', () => {
    const estimates: EstimationResult[] = [
      {
        timestamp: new Date('2020-01-01'),
        serviceEstimates: [],
        periodStartDate: undefined,
        periodEndDate: undefined,
        groupBy: GroupBy.day,
      },
    ]

    const request: EstimationRequest = {
      startDate: new Date('2022-01-02'),
      endDate: new Date('2022-01-02'),
      ignoreCache: false,
      groupBy: 'day',
      skip: 0,
      limit: 1,
    }

    const missingDates = getMissingDates(estimates, request, 'day')
    const expectedDate = moment.utc(request.startDate).startOf('day')

    expect(missingDates).toEqual([moment.utc(expectedDate.toDate())])
  })

  it('modifies config for included cloud providers based on seed value', () => {
    const config = {
      AWS: {
        INCLUDE_ESTIMATES: false,
      },
      GCP: {
        INCLUDE_ESTIMATES: true,
      },
      AZURE: {
        INCLUDE_ESTIMATES: true,
      },
    }
    const cloudProviderToSeed = 'AWS'

    includeCloudProviders(cloudProviderToSeed, config)

    expect(config.AWS.INCLUDE_ESTIMATES).toBe(true)
    expect(config.GCP.INCLUDE_ESTIMATES).toBe(false)
    expect(config.AZURE.INCLUDE_ESTIMATES).toBe(false)
  })

  describe('merging estimates', () => {
    const emptyArray = []
    const singleEstimateArrayOne = [
      {
        timestamp: new Date('2022-01-01'),
        serviceEstimates: [
          {
            cloudProvider: 'AWS',
            kilowattHours: 120,
            co2e: 0.5,
            cost: 100,
            accountId: '1111111111',
            accountName: 'Test Account',
            serviceName: 'EC2',
            region: 'us-east-1',
          },
        ],
        groupBy: GroupBy.day,
      },
    ]
    const singleEstimateArrayTwo = [
      {
        timestamp: new Date('2022-01-01'),
        serviceEstimates: [
          {
            cloudProvider: 'AWS',
            kilowattHours: 100,
            co2e: 0.1,
            cost: 50,
            accountId: '2222222222',
            accountName: 'Other Test Account',
            serviceName: 'EC2',
            region: 'us-east-1',
          },
        ],
        groupBy: GroupBy.day,
      },
    ]
    const mockEstimatesArrayOne = [
      {
        timestamp: new Date('2022-01-01'),
        serviceEstimates: [],
        groupBy: GroupBy.day,
      },
      {
        timestamp: new Date('2022-01-03'),
        serviceEstimates: [],
        groupBy: GroupBy.day,
      },
    ]
    const mockEstimatesArrayTwo = [
      {
        timestamp: new Date('2022-01-02'),
        serviceEstimates: [],
        groupBy: GroupBy.day,
      },
      {
        timestamp: new Date('2022-01-04'),
        serviceEstimates: [],
        groupBy: GroupBy.day,
      },
    ]

    const mergedEstimatesExample = [
      mockEstimatesArrayOne[0],
      mockEstimatesArrayTwo[0],
      mockEstimatesArrayOne[1],
      mockEstimatesArrayTwo[1],
    ]

    it.each([
      [
        'should return an empty array when both input arrays are empty',
        emptyArray,
        emptyArray,
        emptyArray,
      ],
      [
        'should return the first array when the second array is empty',
        singleEstimateArrayOne,
        emptyArray,
        singleEstimateArrayOne,
      ],
      [
        'should return the second array when the first array is empty',
        emptyArray,
        singleEstimateArrayOne,
        singleEstimateArrayOne,
      ],
      [
        'should return first estimate of first array when timestamps are equal',
        singleEstimateArrayOne,
        singleEstimateArrayTwo,
        [...singleEstimateArrayOne],
      ],
      [
        'should merge two arrays with alternating timestamps',
        mockEstimatesArrayOne,
        mockEstimatesArrayTwo,
        mergedEstimatesExample,
      ],
    ])('%s', (_testCase, estimatesOne, estimatesTwo, expected) => {
      const result = mergeEstimates(estimatesOne, estimatesTwo)
      expect(result).toEqual(expected)
    })
  })
})
