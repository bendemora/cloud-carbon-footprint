/*
 * © 2021 Thoughtworks, Inc.
 */

import moment from 'moment'
import {
  EstimationResult,
  getPeriodEndDate,
  GroupBy,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import cache from '../Cache'
import { getMissingDates } from '../common/helpers'
import { EstimationRequest } from '../CreateValidRequest'
import DurationConstructor = moment.unitOfTime.DurationConstructor
import LocalCacheManager from '../LocalCacheManager'

let mockSetEstimates: jest.Mock
let mockGetEstimates: jest.Mock
let mockGetMissingDates: jest.Mock
let mockReplaceEstimates: jest.Mock

jest.mock('../LocalCacheManager', () => {
  return jest.fn().mockImplementation(() => {
    mockSetEstimates = jest.fn()
    mockGetEstimates = jest.fn()
    mockGetMissingDates = jest.fn()
    mockReplaceEstimates = jest.fn()
    return {
      getEstimates: mockGetEstimates,
      setEstimates: mockSetEstimates,
      getMissingDates: mockGetMissingDates,
      replaceEstimates: mockReplaceEstimates,
    }
  })
})

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
}))

const dummyServiceEstimate: ServiceData[] = [
  {
    cloudProvider: '',
    accountId: '',
    accountName: '',
    serviceName: '',
    kilowattHours: 0,
    co2e: 0,
    cost: 0,
    region: '',
    usesAverageCPUConstant: false,
  },
]

function buildFootprintEstimates(
  startDate: string,
  consecutiveTimestamps: number,
  serviceEstimates: ServiceData[] = [],
  timestampUnit: DurationConstructor = 'days',
  groupBy = GroupBy.day,
) {
  return [...Array(consecutiveTimestamps)].map((_value, index) => {
    const timestamp = moment.utc(startDate).add(index, timestampUnit).toDate()
    return {
      timestamp,
      serviceEstimates: [...serviceEstimates],
      periodStartDate: timestamp,
      periodEndDate: getPeriodEndDate(timestamp, GroupBy.day),
      groupBy,
    }
  })
}

describe('Cache', () => {
  let cacheDecorator: (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) => void
  let originalFunction: jest.Mock
  let propertyDescriptor: PropertyDescriptor

  beforeEach(() => {
    jest.clearAllMocks()
    cacheDecorator = cache()
    originalFunction = jest.fn()
    propertyDescriptor = { value: originalFunction }
  })

  it('returns cached data from cache service instead of calling the real method', async () => {
    //setup
    const rawRequest: EstimationRequest = {
      startDate: moment.utc('2020-01-01').toDate(),
      endDate: moment.utc('2020-01-02').toDate(),
      ignoreCache: false,
      groupBy: GroupBy.day,
    }

    mockGetMissingDates.mockResolvedValueOnce([])

    const expectedEstimationResults: EstimationResult[] =
      buildFootprintEstimates('2020-01-01', 2, dummyServiceEstimate)
    mockGetEstimates.mockResolvedValueOnce(expectedEstimationResults)

    const target = {}
    //run
    cacheDecorator(target, 'propertyTest', propertyDescriptor)
    const estimationResult: EstimationResult[] =
      await propertyDescriptor.value(rawRequest)

    //assert
    expect(estimationResult).toEqual(expectedEstimationResults)
  })

  it('calls original function with the expected request', async () => {
    //setup
    const rawRequest: EstimationRequest = {
      startDate: moment.utc('2019-12-31').toDate(),
      endDate: moment.utc('2020-01-02').toDate(),
      ignoreCache: false,
      groupBy: GroupBy.day,
    }

    const cachedEstimates: EstimationResult[] = buildFootprintEstimates(
      '2019-12-31',
      1,
    )

    mockGetMissingDates.mockResolvedValueOnce([
      moment.utc('2020-01-01'),
      moment.utc('2020-01-02'),
    ])

    mockGetEstimates.mockResolvedValueOnce(cachedEstimates)

    const computedEstimates = buildFootprintEstimates('2020-01-01', 1)
    originalFunction.mockResolvedValueOnce(computedEstimates)

    //run
    cacheDecorator({}, 'propertyTest', propertyDescriptor)
    await propertyDescriptor.value(rawRequest)

    //assert
    expect(originalFunction).toHaveBeenCalledWith({
      startDate: moment.utc('2020-01-01').toDate(),
      endDate: moment.utc('2020-01-02').endOf(GroupBy.day).toDate(),
      ignoreCache: false,
      groupBy: GroupBy.day,
    })
  })

  it('calls original function with grouping in the request', async () => {
    //setup
    const rawRequest: EstimationRequest = {
      startDate: moment.utc('2019-12-31').toDate(),
      endDate: moment.utc('2020-01-02').toDate(),
      ignoreCache: false,
      groupBy: GroupBy.day,
    }

    const cachedEstimates: EstimationResult[] = buildFootprintEstimates(
      '2019-12-31',
      7,
    )

    mockGetMissingDates.mockResolvedValueOnce([])

    mockGetEstimates.mockResolvedValueOnce(cachedEstimates)

    //run
    cacheDecorator({}, 'propertyTest', propertyDescriptor)
    await propertyDescriptor.value(rawRequest)

    //assert
    expect(mockGetEstimates).toHaveBeenCalledWith(
      rawRequest,
      rawRequest.groupBy,
    )
  })

  it('does not fetch dates when cache service returns unordered estimates', async () => {
    //setup
    const rawRequest: EstimationRequest = {
      startDate: moment.utc('2020-07-31').toDate(),
      endDate: moment.utc('2020-08-01').toDate(),
      ignoreCache: false,
      groupBy: GroupBy.day,
    }

    //unordered dates
    const cachedEstimates: EstimationResult[] = buildFootprintEstimates(
      '2020-08-01',
      1,
      dummyServiceEstimate,
    ).concat(buildFootprintEstimates('2020-07-31', 1, dummyServiceEstimate))

    mockGetMissingDates.mockResolvedValueOnce([])

    mockGetEstimates.mockResolvedValueOnce(cachedEstimates)

    //run
    cacheDecorator({}, 'propertyTest', propertyDescriptor)
    const estimationResult: EstimationResult[] =
      await propertyDescriptor.value(rawRequest)

    //assert
    const expectedEstimationResults: EstimationResult[] =
      buildFootprintEstimates('2020-07-31', 2, dummyServiceEstimate)

    expect(originalFunction).not.toHaveBeenCalled()
    expect(estimationResult).toEqual(expectedEstimationResults)
  })

  it('saves new data into cache', async () => {
    //setup
    const rawRequest: EstimationRequest = {
      startDate: moment.utc('2019-12-31').toDate(),
      endDate: moment.utc('2020-01-01').toDate(),
      ignoreCache: false,
      groupBy: GroupBy.day,
    }

    const cachedEstimates: EstimationResult[] = []

    mockGetMissingDates.mockResolvedValueOnce([
      moment.utc('2019-12-31'),
      moment.utc('2020-01-01'),
    ])

    mockGetEstimates.mockResolvedValueOnce(cachedEstimates)

    const computedEstimates = buildFootprintEstimates('2019-12-31', 2)
    originalFunction.mockResolvedValueOnce(computedEstimates)

    //run
    cacheDecorator({}, 'propertyTest', propertyDescriptor)
    await propertyDescriptor.value(rawRequest)

    //assert
    expect(mockSetEstimates).toHaveBeenCalledWith(computedEstimates, 'day')
  })

  it('should not save into cache when API response contains empty data', async () => {
    //setup
    const rawRequest: EstimationRequest = {
      startDate: moment.utc('2019-12-31').toDate(),
      endDate: moment.utc('2020-01-01').toDate(),
      ignoreCache: false,
      groupBy: GroupBy.day,
    }

    const cachedEstimates: EstimationResult[] = []

    mockGetMissingDates.mockResolvedValueOnce([
      moment.utc('2019-12-31'),
      moment.utc('2020-01-01'),
    ])

    mockGetEstimates.mockResolvedValueOnce(cachedEstimates)

    const computedEstimates = buildFootprintEstimates('2019-12-31', 1)
    originalFunction.mockResolvedValueOnce(computedEstimates)

    LocalCacheManager.prototype.setEstimates = jest.fn()

    const setEstimatesSpy = jest.spyOn(
      LocalCacheManager.prototype,
      'setEstimates',
    )

    //run
    cacheDecorator({}, 'propertyTest', propertyDescriptor)
    await propertyDescriptor.value(rawRequest)

    //assert
    expect(setEstimatesSpy).not.toHaveBeenCalled()
  })

  it('caches dates with empty estimates if original function returns no results', async () => {
    //setup
    const rawRequest: EstimationRequest = {
      startDate: moment.utc('2020-07-10').toDate(),
      endDate: moment.utc('2020-07-20').toDate(),
      ignoreCache: false,
      groupBy: GroupBy.day,
    }

    const cachedEstimates: EstimationResult[] = []
    mockGetEstimates.mockResolvedValueOnce(cachedEstimates)

    mockGetMissingDates.mockResolvedValueOnce([
      moment.utc('2020-07-15'),
      moment.utc('2020-07-16'),
      moment.utc('2020-07-17'),
      moment.utc('2020-07-18'),
      moment.utc('2020-07-19'),
      moment.utc('2020-07-20'),
    ])

    const computedEstimates: EstimationResult[] = buildFootprintEstimates(
      '2020-07-10',
      5,
      [
        {
          cloudProvider: '',
          accountId: '',
          accountName: '',
          serviceName: '',
          kilowattHours: 0,
          co2e: 0,
          cost: 0,
          region: '',
          usesAverageCPUConstant: false,
        },
      ],
    )
    originalFunction.mockResolvedValueOnce(computedEstimates)

    //run
    cacheDecorator({}, 'propertyTest', propertyDescriptor)
    await propertyDescriptor.value(rawRequest)

    //assert
    expect(mockSetEstimates).toHaveBeenCalledWith(
      computedEstimates.concat(buildFootprintEstimates('2020-07-15', 6)),
      'day',
    )
  })

  it('removes empty estimates', async () => {
    //setup
    const rawRequest: EstimationRequest = {
      startDate: moment.utc('2020-07-15').toDate(),
      endDate: moment.utc('2020-07-20').toDate(),
      ignoreCache: false,
      groupBy: GroupBy.day,
    }

    const cachedEstimates: EstimationResult[] = buildFootprintEstimates(
      '2020-07-15',
      6,
    )

    mockGetMissingDates.mockResolvedValueOnce([])

    mockGetEstimates.mockResolvedValueOnce(cachedEstimates)

    //run
    cacheDecorator({}, 'propertyTest', propertyDescriptor)
    const results = await propertyDescriptor.value(rawRequest)

    //assert
    expect(results).toEqual([])
  })

  it('should not read or write to cache when ignore cache is true', async () => {
    //setup
    const rawRequest: EstimationRequest = {
      startDate: moment.utc('2020-07-12').toDate(),
      endDate: moment.utc('2020-07-20').toDate(),
      ignoreCache: true,
      groupBy: GroupBy.month,
    }

    const cachedEstimates: EstimationResult[] = buildFootprintEstimates(
      '2020-07-15',
      6,
    )

    mockGetMissingDates.mockResolvedValueOnce([moment.utc('2020-07-01')])

    mockGetEstimates.mockResolvedValueOnce(cachedEstimates)

    originalFunction.mockResolvedValueOnce([])

    //run
    cacheDecorator({}, 'propertyTest', propertyDescriptor)
    await propertyDescriptor.value(rawRequest)

    //assert
    const expectedRequest = {
      startDate: moment.utc('2020-07-01').toDate(),
      endDate: moment.utc('2020-07-01').endOf('month').toDate(),
      ignoreCache: false,
      groupBy: GroupBy.month,
    }
    expect(originalFunction).toHaveBeenCalledWith(expectedRequest)
    expect(mockGetEstimates).not.toHaveBeenCalled()
    expect(mockSetEstimates).not.toHaveBeenCalled()
  })

  describe('populates missing dates', () => {
    type TestCase = [string, EstimationRequest, MockRequestDateRanges]
    type MockEstimates = { [grouping: string]: EstimationResult[] }
    type MockRequests = { [grouping: string]: EstimationRequest }
    type MockRequestDateRanges = { [period: string]: Date }[]

    beforeEach(() => {
      jest.clearAllMocks()
      cacheDecorator = cache()
      originalFunction = jest.fn().mockReturnValue([])
      propertyDescriptor = { value: originalFunction }
    })

    /**
     * Answers for the cache manager as the local and bucket managers do:
     * with the dates of the request that the cached estimates do not hold.
     */
    const missingFrom =
      (cached: EstimationResult[]) =>
      async (request: EstimationRequest, grouping: string) =>
        getMissingDates(cached, request, grouping)

    // Mocked Estimates
    const cachedEstimates: MockEstimates = {
      day: buildFootprintEstimates('2020-01-02', 1, dummyServiceEstimate),
      week: buildFootprintEstimates(
        '2020-12-07',
        2,
        dummyServiceEstimate,
        'weeks',
        GroupBy.week,
      ),
      month: buildFootprintEstimates(
        '2020-12-01',
        2,
        dummyServiceEstimate,
        'month',
        GroupBy.month,
      ),
      quarter: buildFootprintEstimates(
        '2020-01-01',
        2,
        dummyServiceEstimate,
        'quarter',
        GroupBy.quarter,
      ),
      year: buildFootprintEstimates(
        '2020-01-01',
        1,
        dummyServiceEstimate,
        'year',
        GroupBy.year,
      ),
    }

    // Mocked requests
    const rawRequests: MockRequests = {
      day: {
        startDate: moment.utc('2019-12-31').toDate(),
        endDate: moment.utc('2020-01-05').toDate(),
        ignoreCache: false,
        groupBy: GroupBy.day,
      },
      week: {
        startDate: moment.utc('2020-12-06').toDate(),
        endDate: moment.utc('2020-12-28').toDate(),
        ignoreCache: false,
        groupBy: GroupBy.week,
      },
      month: {
        startDate: moment.utc('2020-11-01').toDate(),
        endDate: moment.utc('2021-01-01').toDate(),
        ignoreCache: false,
        groupBy: GroupBy.month,
      },
      quarter: {
        startDate: moment.utc('2020-01-01').toDate(),
        endDate: moment.utc('2020-09-01').toDate(),
        ignoreCache: false,
        groupBy: GroupBy.quarter,
      },
      year: {
        startDate: moment.utc('2020-01-01').toDate(),
        endDate: moment.utc('2021-01-01').toDate(),
        ignoreCache: false,
        groupBy: GroupBy.year,
      },
    }

    // One request for each run of adjacent missing dates: from the first
    // date of the run to the end of the period of its last date.
    const expectedRequestRangesByDay: MockRequestDateRanges = [
      {
        start: new Date('2019-12-31T00:00:00.000Z'),
        end: new Date('2020-01-01T23:59:59.999Z'),
      },
      {
        start: new Date('2020-01-03T00:00:00.000Z'),
        end: new Date('2020-01-05T23:59:59.999Z'),
      },
    ]

    // Weeks start on Mondays (ISO weeks), so the first missing week starts
    // before the start date of the request, a Sunday. The window of a run
    // ends on a Saturday all the same: the decorator takes the end of the
    // week from moment's locale week, which starts on a Sunday. The Sunday
    // that ends the last week of a run is therefore not asked for.
    const expectedRequestRangesByWeek: MockRequestDateRanges = [
      {
        start: new Date('2020-11-30T00:00:00.000Z'),
        end: new Date('2020-12-05T23:59:59.999Z'),
      },
      {
        start: new Date('2020-12-21T00:00:00.000Z'),
        end: new Date('2021-01-02T23:59:59.999Z'),
      },
    ]

    const expectedRequestRangesByMonth: MockRequestDateRanges = [
      {
        start: new Date('2020-11-01T00:00:00.000Z'),
        end: new Date('2020-11-30T23:59:59.999Z'),
      },
    ]

    const expectedRequestRangesByQuarter: MockRequestDateRanges = [
      {
        start: new Date('2020-07-01T00:00:00.000Z'),
        end: new Date('2020-09-30T23:59:59.999Z'),
      },
    ]

    const expectedRequestRangesByYear: MockRequestDateRanges = [
      {
        start: new Date('2021-01-01T00:00:00.000Z'),
        end: new Date('2021-12-31T23:59:59.999Z'),
      },
    ]

    // Test Cases for each grouping method
    const missingDateTestCases: TestCase[] = [
      ['day', rawRequests.day, expectedRequestRangesByDay],
      ['week', rawRequests.week, expectedRequestRangesByWeek],
      ['month', rawRequests.month, expectedRequestRangesByMonth],
      ['quarter', rawRequests.quarter, expectedRequestRangesByQuarter],
      ['year', rawRequests.year, expectedRequestRangesByYear],
    ]

    it.each(missingDateTestCases)(
      'fetches dates not stored in cache when grouping by %s',
      async (
        grouping,
        rawRequest: EstimationRequest,
        expectedRequestDateRanges: MockRequestDateRanges,
      ) => {
        //setup
        mockGetMissingDates.mockImplementationOnce(
          missingFrom(cachedEstimates[grouping]),
        )
        mockGetEstimates.mockResolvedValueOnce(cachedEstimates[grouping])

        //run
        cacheDecorator({}, 'propertyTest', propertyDescriptor)
        const estimationResult = await propertyDescriptor.value(rawRequest)

        //assert
        const expectedRequestArguments = expectedRequestDateRanges.map(
          (range) => [
            {
              startDate: range.start,
              endDate: range.end,
              ignoreCache: false,
              groupBy: grouping,
            },
          ],
        )
        // Expect each missing date to be called on getEstimates (decorated function) as a separate request
        expect(originalFunction.mock.calls).toEqual(expectedRequestArguments)
        expect(mockGetMissingDates).toHaveBeenCalledWith(rawRequest, grouping)
        // The dates that were asked for had no estimates, so nothing is
        // written and the answer is what the cache holds.
        expect(mockSetEstimates).not.toHaveBeenCalled()
        expect(estimationResult).toEqual(cachedEstimates[grouping])
      },
    )

    it('does not make additional requests if there are no missing dates', async () => {
      //setup
      mockGetMissingDates.mockResolvedValueOnce([])
      mockGetEstimates.mockResolvedValueOnce(cachedEstimates.year)

      //run
      cacheDecorator({}, 'propertyTest', propertyDescriptor)
      await propertyDescriptor.value({
        startDate: moment.utc('2020-01-01').toDate(),
        endDate: moment.utc('2020-12-31').toDate(),
        ignoreCache: false,
        groupBy: GroupBy.year,
      })

      //assert
      expect(originalFunction).not.toHaveBeenCalled()
    })

    it('makes request for all dates in the range if there are no dates in the cache', async () => {
      //setup
      mockGetMissingDates.mockResolvedValueOnce([
        moment.utc('2020-12-21'),
        moment.utc('2020-12-28'),
      ])
      mockGetEstimates.mockResolvedValueOnce([])

      //run
      cacheDecorator({}, 'propertyTest', propertyDescriptor)
      await propertyDescriptor.value({
        startDate: moment.utc('2020-12-21').toDate(),
        endDate: moment.utc('2021-01-02').toDate(),
        ignoreCache: false,
        groupBy: GroupBy.week,
      })

      const range = expectedRequestRangesByWeek[1]

      //assert
      expect(originalFunction.mock.calls).toEqual([
        [
          {
            startDate: range.start,
            endDate: range.end,
            ignoreCache: false,
            groupBy: GroupBy.week,
          },
        ],
      ])
    })

    it('writes the estimates of every run of missing dates to the cache in one call, and answers with what the cache then holds', async () => {
      //setup
      const rawRequest = rawRequests.day
      mockGetMissingDates.mockImplementationOnce(
        missingFrom(cachedEstimates.day),
      )
      const firstRun = buildFootprintEstimates(
        '2019-12-31',
        2,
        dummyServiceEstimate,
      )
      const secondRun = buildFootprintEstimates(
        '2020-01-03',
        3,
        dummyServiceEstimate,
      )
      originalFunction
        .mockResolvedValueOnce(firstRun)
        .mockResolvedValueOnce(secondRun)
      const heldByTheCache = buildFootprintEstimates(
        '2019-12-31',
        6,
        dummyServiceEstimate,
      )
      mockGetEstimates.mockResolvedValueOnce(heldByTheCache)

      //run
      cacheDecorator({}, 'propertyTest', propertyDescriptor)
      const estimationResult = await propertyDescriptor.value(rawRequest)

      //assert
      expect(originalFunction).toHaveBeenCalledTimes(2)
      expect(mockSetEstimates).toHaveBeenCalledTimes(1)
      expect(mockSetEstimates).toHaveBeenCalledWith(
        [...firstRun, ...secondRun],
        'day',
      )
      expect(estimationResult).toEqual(heldByTheCache)
    })

    it('caches a missing date that has no estimates as an empty result, so that it is not asked for again', async () => {
      //setup
      mockGetMissingDates.mockImplementationOnce(
        missingFrom(cachedEstimates.day),
      )
      // The first run has estimates for one of its two dates, the second
      // for none of its three.
      const estimated = buildFootprintEstimates(
        '2020-01-01',
        1,
        dummyServiceEstimate,
      )
      originalFunction.mockResolvedValueOnce(estimated)
      mockGetEstimates.mockResolvedValueOnce([])

      //run
      cacheDecorator({}, 'propertyTest', propertyDescriptor)
      await propertyDescriptor.value(rawRequests.day)

      //assert
      expect(mockSetEstimates).toHaveBeenCalledWith(
        [
          ...buildFootprintEstimates('2019-12-31', 1),
          ...estimated,
          ...buildFootprintEstimates('2020-01-03', 3),
        ],
        'day',
      )
    })

    it('hands the other fields of the request on to each request for missing dates', async () => {
      //setup
      const rawRequest: EstimationRequest = {
        ...rawRequests.day,
        cloudProviderToSeed: 'AWS',
        accounts: ['account-1'],
      }
      mockGetMissingDates.mockImplementationOnce(
        missingFrom(cachedEstimates.day),
      )
      mockGetEstimates.mockResolvedValueOnce(cachedEstimates.day)

      //run
      cacheDecorator({}, 'propertyTest', propertyDescriptor)
      await propertyDescriptor.value(rawRequest)

      //assert
      expect(originalFunction.mock.calls).toEqual(
        expectedRequestRangesByDay.map((range) => [
          {
            startDate: range.start,
            endDate: range.end,
            ignoreCache: false,
            groupBy: GroupBy.day,
            cloudProviderToSeed: 'AWS',
            accounts: ['account-1'],
          },
        ]),
      )
    })

    it('calls the original function on the object it decorates, which for a method is the prototype', async () => {
      //setup
      const target = { name: 'the prototype' }
      mockGetMissingDates.mockResolvedValueOnce([moment.utc('2020-01-03')])
      mockGetEstimates.mockResolvedValueOnce([])

      //run
      cacheDecorator(target, 'propertyTest', propertyDescriptor)
      await propertyDescriptor.value.call(
        { name: 'an instance' },
        {
          ...rawRequests.day,
        },
      )

      //assert
      expect(originalFunction.mock.contexts).toEqual([target])
    })

    it('answers with a cached period that holds provisional rows as it is: a read never estimates it again or replaces it', async () => {
      //setup
      const provisionalEstimates: EstimationResult[] = buildFootprintEstimates(
        '2020-01-02',
        1,
        [
          {
            ...dummyServiceEstimate[0],
            provenance: {
              sourceId: 'live',
              zoneId: 'GB',
              granularity: 'day',
              basis: 'location-consumption',
              factorType: 'direct',
              isEstimated: true,
              licenceId: 'CC-BY-4.0',
              qualityTier: 'C',
              gCO2ePerKWh: 100,
              modelVersion: 'unversioned',
              isProvisional: true,
            },
          },
        ],
      )
      const rawRequest: EstimationRequest = {
        startDate: moment.utc('2020-01-02').toDate(),
        endDate: moment.utc('2020-01-02').toDate(),
        ignoreCache: false,
        groupBy: GroupBy.day,
      }
      mockGetMissingDates.mockImplementationOnce(
        missingFrom(provisionalEstimates),
      )
      mockGetEstimates.mockResolvedValueOnce(provisionalEstimates)

      //run
      cacheDecorator({}, 'propertyTest', propertyDescriptor)
      const estimationResult = await propertyDescriptor.value(rawRequest)

      //assert
      expect(estimationResult).toEqual(provisionalEstimates)
      expect(originalFunction).not.toHaveBeenCalled()
      expect(mockSetEstimates).not.toHaveBeenCalled()
      expect(mockReplaceEstimates).not.toHaveBeenCalled()
    })
  })
})
