/*
 * © 2021 Thoughtworks, Inc.
 */

import {
  cachedPeriodsOf,
  getCachedData,
  writeToFile,
  getCacheFileName,
  getMissingDates,
  includeCloudProviders,
  isWorseTier,
  mergeEstimates,
  readCachedData,
  replacePeriods,
  regionIdOf,
  worstTiersOf,
} from '../../common/helpers'
import { constants } from 'buffer'
import { FileHandle } from 'fs/promises'
import { Readable, Stream } from 'stream'
import {
  EstimationResult,
  GroupBy,
  QualityTier,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import { CachedPeriod } from '../../CacheManager'
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

  /** A service estimate of a provider. Its name tells the rows apart. */
  const rowOf = (
    cloudProvider: string,
    serviceName: string,
    isProvisional?: boolean,
  ): ServiceData => ({
    cloudProvider,
    kilowattHours: 1,
    co2e: 1,
    cost: 1,
    accountId: 'account',
    accountName: 'account',
    serviceName,
    region: 'region',
    ...(isProvisional !== undefined && {
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
    }),
  })

  /** A row of a provider and region: with the tier, or without provenance. */
  const tieredRow = (
    cloudProvider: string,
    region: string,
    qualityTier?: QualityTier,
  ): ServiceData => {
    const row = rowOf(cloudProvider, 'service', qualityTier && false)
    return {
      ...row,
      region,
      ...(qualityTier && { provenance: { ...row.provenance, qualityTier } }),
    }
  }

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

  const namesOf = (estimates: EstimationResult[]) =>
    estimates.map(({ timestamp, serviceEstimates }) => [
      timestamp.toISOString().slice(0, 10),
      serviceEstimates.map((row) => row.serviceName),
    ])

  describe('reading a cache that must be whole', () => {
    it('reads the estimation results as getCachedData does', async () => {
      const cacheFile = () =>
        Readable.from([
          '[\n',
          JSON.stringify(dayOf('2026-11-01', [rowOf('AWS', 'one')])),
          '\n,\n',
          JSON.stringify(dayOf('2026-11-02', [])),
          '\n]',
        ])

      const cachedData = await readCachedData(cacheFile())

      expect(namesOf(cachedData)).toEqual([
        ['2026-11-01', ['one']],
        ['2026-11-02', []],
      ])
      expect(cachedData).toEqual(await getCachedData(cacheFile()))
    })

    it('fails when the stream it reads from fails', async () => {
      const failing = new Readable({
        read() {
          this.push('[\n')
          this.destroy(new Error('the read failed'))
        },
      })

      await expect(readCachedData(failing)).rejects.toThrow('the read failed')
    })

    it('fails when a line cannot be parsed', async () => {
      const truncated = Readable.from(['[\n', '{"timestamp":"2026-11-01T00'])

      await expect(readCachedData(truncated)).rejects.toThrow(SyntaxError)
    })

    it('holds nothing for a cache that was created empty, which getCachedData reads as one empty array', async () => {
      // What the cache managers write when they find no cache.
      const created = () => Readable.from(['[]'])

      expect(await getCachedData(created())).toEqual([[]])
      expect(await readCachedData(created())).toEqual([])
    })

    it('leaves out the empty array that the first write to a new local cache file carries along', async () => {
      const afterTheFirstWrite = Readable.from([
        '[\n',
        JSON.stringify(dayOf('2026-11-01', [rowOf('AWS', 'one')])),
        '\n,\n',
        '[]',
        '\n]',
      ])

      expect(namesOf(await readCachedData(afterTheFirstWrite))).toEqual([
        ['2026-11-01', ['one']],
      ])
    })

    it.each([
      ['has no timestamp', '{"serviceEstimates":[]}', undefined],
      [
        'has a timestamp that is not a date',
        '{"timestamp":"2026-13-45T00:00:00.000Z","serviceEstimates":[]}',
        '{"timestamp":null,"serviceEstimates":[]}',
      ],
      ['has no rows', '{"timestamp":"2026-11-01T00:00:00.000Z"}', undefined],
      ['is an array that is not empty', '[1]', undefined],
      ['is null', 'null', undefined],
    ])('fails when an entry %s', async (_what, line, asReported = line) => {
      const cacheFile = Readable.from(['[\n', line, '\n]'])

      await expect(readCachedData(cacheFile)).rejects.toThrow(
        `The estimates cache holds an entry that is not an estimation result: ${asReported}`,
      )
    })
  })

  describe('replacing periods', () => {
    const cached = () => [
      dayOf('2026-11-01', [rowOf('AWS', 'aws-1'), rowOf('GCP', 'gcp-1')]),
      dayOf('2026-11-02', [rowOf('AWS', 'aws-2'), rowOf('GCP', 'gcp-2')]),
      dayOf('2026-11-03', [rowOf('AWS', 'aws-3')]),
    ]

    it('puts the new rows of a period in place of all its cached rows when no providers are given', () => {
      const replaced = replacePeriods(cached(), [
        dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')]),
      ])

      expect(namesOf(replaced)).toEqual([
        ['2026-11-01', ['aws-1', 'gcp-1']],
        ['2026-11-02', ['new-aws-2']],
        ['2026-11-03', ['aws-3']],
      ])
    })

    it('replaces only the rows of the given providers, whatever their case', () => {
      const replaced = replacePeriods(
        cached(),
        [dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])],
        ['aws'],
      )

      expect(namesOf(replaced)).toEqual([
        ['2026-11-01', ['aws-1', 'gcp-1']],
        ['2026-11-02', ['gcp-2', 'new-aws-2']],
        ['2026-11-03', ['aws-3']],
      ])
    })

    it('matches a provider given in upper case with cached rows in another case', () => {
      const replaced = replacePeriods(
        [dayOf('2026-11-01', [rowOf('AliCloud', 'ali-1'), rowOf('AWS', 'x')])],
        [dayOf('2026-11-01', [rowOf('AliCloud', 'new-ali-1')])],
        ['ALICLOUD'],
      )

      expect(namesOf(replaced)).toEqual([['2026-11-01', ['x', 'new-ali-1']]])
    })

    it('keeps every cached row of a period when the list of providers is empty', () => {
      const replaced = replacePeriods(
        cached(),
        [dayOf('2026-11-03', [rowOf('GCP', 'new-gcp-3')])],
        [],
      )

      expect(namesOf(replaced)[2]).toEqual([
        '2026-11-03',
        ['aws-3', 'new-gcp-3'],
      ])
    })

    it('adds a period that is not cached, in timestamp order', () => {
      const replaced = replacePeriods(
        [
          dayOf('2026-11-01', [rowOf('AWS', 'aws-1')]),
          dayOf('2026-11-03', [rowOf('AWS', 'aws-3')]),
        ],
        [
          dayOf('2026-11-04', [rowOf('AWS', 'new-aws-4')]),
          dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')]),
        ],
        ['AWS'],
      )

      expect(namesOf(replaced)).toEqual([
        ['2026-11-01', ['aws-1']],
        ['2026-11-02', ['new-aws-2']],
        ['2026-11-03', ['aws-3']],
        ['2026-11-04', ['new-aws-4']],
      ])
    })

    it('leaves the periods that are not among the new estimates as they are', () => {
      const before = cached()

      const replaced = replacePeriods(before, [
        dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')]),
      ])

      expect(replaced[0]).toBe(before[0])
      expect(replaced[2]).toBe(before[2])
    })

    it('keeps the period and the other fields of the new result', () => {
      const newResult = dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])

      const [, replaced] = replacePeriods(cached(), [newResult], ['AWS'])

      expect(replaced).toEqual({
        ...newResult,
        serviceEstimates: [rowOf('GCP', 'gcp-2'), rowOf('AWS', 'new-aws-2')],
      })
    })

    it('takes new results that share a timestamp as the rows of one period', () => {
      const replaced = replacePeriods(cached(), [
        dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')]),
        dayOf('2026-11-02', [rowOf('GCP', 'new-gcp-2')]),
      ])

      expect(namesOf(replaced)[1]).toEqual([
        '2026-11-02',
        ['new-aws-2', 'new-gcp-2'],
      ])
      expect(replaced).toHaveLength(3)
    })

    it('leaves one result for a replaced period that the cache held twice', () => {
      // What appending the same date twice left in a cache object.
      const twice = [
        dayOf('2026-11-02', [rowOf('AWS', 'aws-2'), rowOf('GCP', 'gcp-2')]),
        dayOf('2026-11-01', [rowOf('AWS', 'aws-1')]),
        dayOf('2026-11-02', [rowOf('AWS', 'aws-2'), rowOf('AZURE', 'az-2')]),
      ]
      const newEstimates = [dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])]

      expect(namesOf(replacePeriods(twice, newEstimates))).toEqual([
        ['2026-11-01', ['aws-1']],
        ['2026-11-02', ['new-aws-2']],
      ])
      expect(namesOf(replacePeriods(twice, newEstimates, ['AWS']))).toEqual([
        ['2026-11-01', ['aws-1']],
        ['2026-11-02', ['gcp-2', 'az-2', 'new-aws-2']],
      ])
    })

    it('adds the new estimates to an empty cache', () => {
      const newEstimates = [dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])]

      expect(replacePeriods([], newEstimates, ['AWS'])).toEqual(newEstimates)
    })

    it('leaves out a cached entry that has no timestamp, as an empty cache file reads', () => {
      // What getCachedData makes of a cache that was created holding "[]".
      const emptyCache = [] as unknown as EstimationResult
      const [first, second, third] = cached()

      const replaced = replacePeriods(
        [third, emptyCache, first, second],
        [dayOf('2026-11-02', [rowOf('AWS', 'new-aws-2')])],
      )

      expect(namesOf(replaced)).toEqual([
        ['2026-11-01', ['aws-1', 'gcp-1']],
        ['2026-11-02', ['new-aws-2']],
        ['2026-11-03', ['aws-3']],
      ])
    })
  })

  describe('listing the cached periods', () => {
    const cached = () => [
      dayOf('2026-11-01', [rowOf('AWS', 'final', false)]),
      dayOf('2026-11-02', [
        rowOf('AWS', 'final', false),
        rowOf('GCP', 'provisional', true),
      ]),
      dayOf('2026-11-03', [rowOf('AWS', 'cached before provenance')]),
      dayOf('2026-11-04', []),
    ]

    /** The dates of the periods and whether each is provisional. */
    const flagsOf = (periods: CachedPeriod[]) =>
      periods.map(({ timestamp, isProvisional }) => [
        timestamp.toISOString().slice(0, 10),
        isProvisional,
      ])

    it('calls a period provisional when at least one of its rows is', () => {
      expect(flagsOf(cachedPeriodsOf(cached()))).toEqual([
        ['2026-11-01', false],
        ['2026-11-02', true],
        ['2026-11-03', false],
        ['2026-11-04', false],
      ])
    })

    it('counts only a marker that is true', () => {
      const row = rowOf('AWS', 'marked', false)
      const marked = (isProvisional: unknown) =>
        dayOf('2026-11-01', [
          { ...row, provenance: { ...row.provenance, isProvisional } },
        ] as ServiceData[])

      expect(cachedPeriodsOf([marked('true')])[0].isProvisional).toBe(false)
      expect(cachedPeriodsOf([marked(false)])[0].isProvisional).toBe(false)
      expect(cachedPeriodsOf([marked(true)])[0].isProvisional).toBe(true)
    })

    it('keeps the periods whose timestamp lies in the range, both ends included', () => {
      const periods = cachedPeriodsOf(cached(), {
        startDate: new Date('2026-11-02'),
        endDate: new Date('2026-11-03'),
      })

      expect(periods.map(({ timestamp }) => timestamp)).toEqual([
        new Date('2026-11-02'),
        new Date('2026-11-03'),
      ])
    })

    it('leaves out a period that starts after the last moment of the range', () => {
      const periods = cachedPeriodsOf(cached(), {
        startDate: new Date('2026-10-01'),
        endDate: new Date('2026-11-01T23:59:59.999Z'),
      })

      expect(flagsOf(periods)).toEqual([['2026-11-01', false]])
    })

    it('answers oldest first and counts results that share a timestamp as one period', () => {
      const periods = cachedPeriodsOf([
        dayOf('2026-11-02', [rowOf('AWS', 'final', false)]),
        dayOf('2026-11-01', [rowOf('AWS', 'provisional', true)]),
        dayOf('2026-11-02', [rowOf('GCP', 'provisional', true)]),
        dayOf('2026-11-01', [rowOf('GCP', 'final', false)]),
      ])

      expect(flagsOf(periods)).toEqual([
        ['2026-11-01', true],
        ['2026-11-02', true],
      ])
      expect(periods[1].worstTiers).toEqual([
        { cloudProvider: 'AWS', region: 'region', qualityTier: 'B' },
        { cloudProvider: 'GCP', region: 'region', qualityTier: 'B' },
      ])
    })

    it('gives the worst tier of the rows of each provider and region of a period', () => {
      const [period] = cachedPeriodsOf([
        dayOf('2026-11-01', [
          tieredRow('AWS', 'eu-west-2', 'B'),
          tieredRow('AWS', 'eu-west-2', 'C'),
          tieredRow('AWS', 'us-east-1', 'D'),
          tieredRow('GCP', 'europe-west2', 'A'),
          tieredRow('AZURE', 'uksouth'),
        ]),
      ])

      expect(period).toEqual({
        timestamp: new Date('2026-11-01'),
        isProvisional: false,
        worstTiers: [
          { cloudProvider: 'AWS', region: 'eu-west-2', qualityTier: 'C' },
          { cloudProvider: 'AWS', region: 'us-east-1', qualityTier: 'D' },
          { cloudProvider: 'GCP', region: 'europe-west2', qualityTier: 'A' },
        ],
      })
    })

    it('has no tiers for a period whose rows have no provenance, or that has no rows', () => {
      const periods = cachedPeriodsOf(cached())

      expect(periods[2].worstTiers).toEqual([])
      expect(periods[3].worstTiers).toEqual([])
    })

    it('has no periods for an empty cache', () => {
      expect(cachedPeriodsOf([])).toEqual([])
    })
  })

  describe('the worst quality tier of rows', () => {
    it.each([
      ['B', 'A', true],
      ['C', 'B', true],
      ['D', 'C', true],
      ['D', 'A', true],
      ['B', 'B', false],
      ['A', 'B', false],
      ['C', 'D', false],
    ])('says whether tier %s is worse than tier %s', (tier, than, isWorse) => {
      expect(isWorseTier(tier as QualityTier, than as QualityTier)).toBe(
        isWorse,
      )
    })

    it('takes the worst tier of each provider and region, whatever the order of the rows', () => {
      expect(
        worstTiersOf([
          tieredRow('AWS', 'eu-west-2', 'D'),
          tieredRow('AWS', 'eu-west-2', 'B'),
          tieredRow('AWS', 'us-east-1', 'A'),
          tieredRow('AWS', 'us-east-1', 'B'),
          tieredRow('GCP', 'eu-west-2', 'C'),
        ]),
      ).toEqual([
        { cloudProvider: 'AWS', region: 'eu-west-2', qualityTier: 'D' },
        { cloudProvider: 'AWS', region: 'us-east-1', qualityTier: 'B' },
        { cloudProvider: 'GCP', region: 'eu-west-2', qualityTier: 'C' },
      ])
    })

    it('takes one provider for one, whatever the case of its name', () => {
      expect(
        worstTiersOf([
          tieredRow('aws', 'eu-west-2', 'B'),
          tieredRow('AWS', 'eu-west-2', 'C'),
        ]),
      ).toEqual([
        { cloudProvider: 'AWS', region: 'eu-west-2', qualityTier: 'C' },
      ])
      expect(regionIdOf('aws', 'eu-west-2')).toEqual(
        regionIdOf('AWS', 'eu-west-2'),
      )
      expect(regionIdOf('AWS', 'eu-west-2')).not.toEqual(
        regionIdOf('AWS', 'EU-WEST-2'),
      )
    })

    it('leaves out rows without provenance, and rows whose tier is not one of the four', () => {
      const unknownTier = tieredRow('AWS', 'eu-west-2', 'B')
      unknownTier.provenance.qualityTier = 'E' as QualityTier

      expect(
        worstTiersOf([
          tieredRow('AWS', 'us-east-1'),
          unknownTier,
          tieredRow('GCP', 'europe-west2', 'B'),
        ]),
      ).toEqual([
        { cloudProvider: 'GCP', region: 'europe-west2', qualityTier: 'B' },
      ])
      expect(worstTiersOf([])).toEqual([])
    })
  })
})
