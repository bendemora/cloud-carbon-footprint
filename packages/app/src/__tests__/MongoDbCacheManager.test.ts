/**
 * © 2021 Thoughtworks, Inc.
 */

import * as mongo from 'mongodb'
import moment, { Moment } from 'moment'
import {
  configLoader,
  EstimationResult,
  GroupBy,
  Logger,
} from '@cloud-carbon-footprint/common'
import MongoDbCacheManager from '../MongoDbCacheManager'
import { getDatesWithinRequestTimeFrame } from '../common/helpers'
import { EstimationRequest } from '../CreateValidRequest'

jest.mock('mongodb', () => {
  return {
    MongoClient: jest.fn().mockImplementation(() => {
      return {
        connect: jest.fn(),
        close: jest.fn(),
        db: jest.fn().mockReturnValue({}),
      }
    }),
    ServerApiVersion: jest.fn().mockImplementation(() => {
      return {}
    }),
  }
})

jest.mock('@cloud-carbon-footprint/common', () => ({
  ...(jest.requireActual('@cloud-carbon-footprint/common') as Record<
    string,
    unknown
  >),
  configLoader: jest.fn().mockImplementation(() => {
    return {
      MONGODB: {
        URI: 'test-mongo-uri',
      },
    }
  }),
}))

jest.mock('../common/helpers', () => {
  const requireActual = jest.requireActual('../common/helpers')
  return {
    ...requireActual,
    getDatesWithinRequestTimeFrame: jest.fn(),
  }
})

const mockGetDates = getDatesWithinRequestTimeFrame as jest.Mock
const mockAggregation = jest.fn()

const { BSON, ObjectId } = jest.requireActual('mongodb')
const MONGODB_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

type Doc = Record<string, any>

const fieldValue = (doc: Doc, expression: string) =>
  expression === '$$ROOT' ? doc : doc[expression.slice(1)]

const unsetPath = (doc: Doc, path: string): Doc => {
  const [head, ...rest] = path.split('.')
  if (rest.length === 0) {
    const { [head]: _removed, ...kept } = doc
    return kept
  }
  const value = doc[head]
  return {
    ...doc,
    [head]: Array.isArray(value)
      ? value.map((item) => unsetPath(item, rest.join('.')))
      : unsetPath(value, rest.join('.')),
  }
}

const groupDocs = (docs: Doc[], spec: Doc): Doc[] => {
  const { _id: key, ...accumulators } = spec
  const groups = new Map<unknown, Doc>()
  for (const doc of docs) {
    const id = fieldValue(doc, key)
    const groupKey = id instanceof Date ? id.getTime() : id
    if (!groups.has(groupKey)) {
      const group: Doc = { _id: id }
      for (const [field, accumulator] of Object.entries(accumulators)) {
        if ('$first' in accumulator)
          group[field] = fieldValue(doc, accumulator.$first)
        if ('$push' in accumulator) group[field] = []
      }
      groups.set(groupKey, group)
    }
    for (const [field, accumulator] of Object.entries(accumulators)) {
      if ('$push' in accumulator)
        groups.get(groupKey)[field].push(fieldValue(doc, accumulator.$push))
    }
  }
  return [...groups.values()]
}

const sortDocs = (docs: Doc[], spec: Doc): Doc[] =>
  [...docs].sort((a, b) => {
    for (const [field, direction] of Object.entries(spec)) {
      if (a[field] < b[field]) return -direction
      if (a[field] > b[field]) return direction
    }
    return 0
  })

/**
 * Stands in for collection.aggregate: runs the stages loadEstimates uses
 * against in-memory rows and, like the server, fails when the pipeline would
 * return a document larger than MongoDB's 16 MiB BSON document limit.
 */
const fakeAggregate =
  (rows: Doc[]) =>
  (stages: Doc[]): AsyncIterable<Doc> & { toArray: () => Promise<Doc[]> } => {
    let docs = rows
    for (const stage of stages) {
      const [operator, spec] = Object.entries(stage)[0]
      if (operator === '$match')
        continue // every fixture row matches
      else if (operator === '$skip') docs = docs.slice(spec)
      else if (operator === '$limit') docs = docs.slice(0, spec)
      else if (operator === '$sort') docs = sortDocs(docs, spec)
      else if (operator === '$group') docs = groupDocs(docs, spec)
      else if (operator === '$unset')
        docs = docs.map((doc) =>
          spec.reduce((kept: Doc, path: string) => unsetPath(kept, path), doc),
        )
      else throw new Error(`fakeAggregate does not support ${operator}`)
    }
    const checkSize = (doc: Doc) => {
      const bytes = BSON.calculateObjectSize(doc)
      if (bytes > MONGODB_MAX_DOCUMENT_BYTES)
        throw new Error(`BSONObjectTooLarge: document is ${bytes} bytes`)
      return doc
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (const doc of docs) yield checkSize(doc)
      },
      toArray: async () => docs.map(checkSize),
    }
  }

const failingCursor = (error: Error) => ({
  // eslint-disable-next-line require-yield
  async *[Symbol.asyncIterator]() {
    throw error
  },
  toArray: async () => {
    throw error
  },
})

const staticProvenance = {
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
}

/*
 * Ids that increase in creation order, as loadEstimates sorts rows by
 * timestamp and _id. new ObjectId() does not guarantee that: its counter
 * starts at random and wraps at 0xffffff (bson objectid.js), so ids made in
 * the same second after a wrap sort before earlier ones.
 */
let rowSequence = 0
const nextRowId = () =>
  new ObjectId((++rowSequence).toString(16).padStart(24, '0'))

/** A row as setEstimates stores it: a service estimate plus timestamp and groupBy. */
const storedRow = (timestamp: Date, index: number): Doc => ({
  _id: nextRowId(),
  cloudProvider: 'AWS',
  kilowattHours: 0.0123456789012,
  co2e: 0.00000412345678901,
  cost: 1.23456789,
  usesAverageCPUConstant: false,
  accountId: '123456789012',
  accountName: '123456789012',
  serviceName: `AmazonEC2-${index}`,
  region: 'us-east-1',
  provenance: staticProvenance,
  timestamp,
  groupBy: 'day',
})

const asServiceEstimate = ({
  _id,
  timestamp: _timestamp,
  groupBy: _groupBy,
  ...row
}: Doc) => row

describe('MongoDbCacheManager', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('connects to the mongodb server with URI', async () => {
    jest.spyOn(Logger.prototype, 'info').mockImplementation()

    await MongoDbCacheManager.createDbConnection()

    expect(mongo.MongoClient).toHaveBeenCalledWith('test-mongo-uri')
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      'Successfully connected to the MongoDB client',
    )
  })

  it('connects to the mongodb server with credentials', async () => {
    ;(configLoader as jest.Mock).mockReturnValue({
      ...configLoader(),
      MONGODB: {
        URI: 'test-mongo-uri',
        CREDENTIALS: 'test-mongo-credentials',
      },
    })
    jest.spyOn(Logger.prototype, 'info').mockImplementation()

    await MongoDbCacheManager.createDbConnection()

    expect(mongo.MongoClient).toHaveBeenCalledWith('test-mongo-uri', {
      serverApi: undefined,
      sslCert: 'test-mongo-credentials',
      sslKey: 'test-mongo-credentials',
    })

    expect(Logger.prototype.info).toHaveBeenCalledWith(
      'Successfully connected to the MongoDB client',
    )
  })

  it('throws an error when there is no uri set', async () => {
    ;(configLoader as jest.Mock).mockReturnValue({
      ...configLoader(),
      MONGODB: {
        URI: '',
      },
    })

    jest.spyOn(Logger.prototype, 'error').mockImplementation()

    await MongoDbCacheManager.createDbConnection()

    expect(mongo.MongoClient).not.toHaveBeenCalled()
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'There was an error connecting to the MongoDB client',
      new Error('Please provide a valid URI'),
    )
  })

  describe('gets estimates', () => {
    const mockClient: Partial<mongo.MongoClient> = {
      db: jest.fn().mockReturnThis(),
      close: jest.fn(),
      connect: jest.fn(),
    }

    const testDate = new Date('2022-01-01')
    const mockEstimates: EstimationResult[] = [
      {
        timestamp: testDate,
        groupBy: GroupBy.day,
        serviceEstimates: [],
        periodStartDate: testDate,
        periodEndDate: testDate,
      },
    ]

    const request = {
      startDate: testDate,
      endDate: new Date('2022-01-02'),
      ignoreCache: false,
    }

    beforeEach(() => {
      ;(configLoader as jest.Mock).mockReturnValue({
        ...configLoader(),
        MONGODB_URI: 'test-mongo-uri',
      })
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('successfully gets estimates', async () => {
      const mongoDbCacheManager = new MongoDbCacheManager()

      jest
        .spyOn(MongoDbCacheManager, 'createDbConnection')
        .mockImplementation(async () => {
          MongoDbCacheManager.mongoClient = mockClient as mongo.MongoClient
        })

      const loadEstimatesSpy = jest.spyOn(mongoDbCacheManager, 'loadEstimates')
      ;(loadEstimatesSpy as jest.Mock).mockResolvedValue(mockEstimates)

      const estimates = await mongoDbCacheManager.getEstimates(request, 'day')

      expect(estimates).toEqual(mockEstimates)
    })

    it('fails instead of returning no estimates when loading them fails', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation()
      const mongoDbCacheManager = new MongoDbCacheManager()

      jest
        .spyOn(MongoDbCacheManager, 'createDbConnection')
        .mockImplementation(async () => {
          MongoDbCacheManager.mongoClient = mockClient as mongo.MongoClient
        })

      const testError = new Error('Example error')

      const loadEstimatesSpy = jest.spyOn(mongoDbCacheManager, 'loadEstimates')
      ;(loadEstimatesSpy as jest.Mock).mockRejectedValue(testError)

      await expect(
        mongoDbCacheManager.getEstimates(request, 'day'),
      ).rejects.toThrow(testError)
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'There was an error getting estimates from MongoDB',
        testError,
      )
    })
  })

  describe('loads estimates', () => {
    let mockClient: Partial<mongo.MongoClient>
    const testDate = new Date('2022-01-01')
    const nextDate = new Date('2022-01-02')
    const rows = [
      storedRow(testDate, 0),
      storedRow(nextDate, 1),
      storedRow(testDate, 2),
    ]
    const expectedEstimates = [
      {
        timestamp: testDate,
        serviceEstimates: [
          asServiceEstimate(rows[0]),
          asServiceEstimate(rows[2]),
        ],
        groupBy: 'day',
      },
      {
        timestamp: nextDate,
        serviceEstimates: [asServiceEstimate(rows[1])],
        groupBy: 'day',
      },
    ]

    const request = {
      startDate: testDate,
      endDate: nextDate,
      ignoreCache: false,
      groupBy: 'day',
      skip: 0,
      limit: 10,
    }

    const mockClientWithRows = (
      aggregate: (stages: Doc[]) => unknown,
    ): Partial<mongo.MongoClient> => ({
      db: jest.fn().mockImplementation(() => ({
        listCollections: jest.fn().mockImplementation(() => ({
          next: jest.fn().mockImplementation((callback) => {
            callback(undefined, { name: 'test-collection' })
          }),
        })),
        collection: jest.fn().mockImplementation(() => ({
          aggregate: mockAggregation.mockImplementation(aggregate),
        })),
      })),
      close: jest.fn(),
      connect: jest.fn(),
    })

    const loadEstimates = async (
      client: Partial<mongo.MongoClient>,
      estimationRequest: EstimationRequest,
    ) => {
      const mongoDbCacheManager = new MongoDbCacheManager()
      jest
        .spyOn(MongoDbCacheManager, 'createDbConnection')
        .mockImplementation(async () => {
          MongoDbCacheManager.mongoClient = client as mongo.MongoClient
        })
      await MongoDbCacheManager.createDbConnection()
      return mongoDbCacheManager.loadEstimates(
        MongoDbCacheManager.mongoClient.db(mongoDbCacheManager.mongoDbName),
        'estimates-by-day',
        estimationRequest,
      )
    }

    beforeEach(() => {
      mockClient = mockClientWithRows(fakeAggregate(rows))
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('loads estimates from a mongo database collection', async () => {
      jest.spyOn(Logger.prototype, 'info').mockImplementation()

      const estimates = await loadEstimates(mockClient, request)

      expect(Logger.prototype.info).toHaveBeenCalledWith(
        `Paginating documents: ${request.skip} to ${
          request.skip + request.limit
        }`,
      )
      expect(estimates).toEqual(expectedEstimates)
    })

    it('groups a 50,000-row page of one day with provenance without returning one oversized document', async () => {
      jest.spyOn(Logger.prototype, 'info').mockImplementation()
      const oneDayOfRows = Array.from({ length: 50000 }, (_, index) =>
        storedRow(testDate, index),
      )
      // The rows of one day, grouped into one document, exceed the limit.
      expect(
        BSON.calculateObjectSize({
          serviceEstimates: oneDayOfRows.map(asServiceEstimate),
        }),
      ).toBeGreaterThan(MONGODB_MAX_DOCUMENT_BYTES)

      const estimates = await loadEstimates(
        mockClientWithRows(fakeAggregate(oneDayOfRows)),
        { ...request, limit: undefined },
      )

      expect(estimates).toHaveLength(1)
      expect(estimates[0].timestamp).toEqual(testDate)
      expect(estimates[0].groupBy).toEqual('day')
      expect(estimates[0].serviceEstimates).toHaveLength(50000)
      expect(estimates[0].serviceEstimates[0]).toEqual(
        asServiceEstimate(oneDayOfRows[0]),
      )
      expect(estimates[0].serviceEstimates[49999]).toEqual(
        asServiceEstimate(oneDayOfRows[49999]),
      )
    })

    it('fails when reading the aggregation fails', async () => {
      jest.spyOn(Logger.prototype, 'info').mockImplementation()
      const cursorError = new Error('cursor error')

      await expect(
        loadEstimates(
          mockClientWithRows(() => failingCursor(cursorError)),
          request,
        ),
      ).rejects.toThrow(cursorError)
    })

    it('fails when listing the collections fails', async () => {
      jest.spyOn(Logger.prototype, 'info').mockImplementation()
      const listError = new Error('list error')
      const mockClientWithListError: Partial<mongo.MongoClient> = {
        db: jest.fn().mockImplementation(() => ({
          createCollection: jest.fn(),
          listCollections: jest.fn().mockImplementation(() => ({
            next: jest.fn().mockImplementation((callback) => {
              callback(listError)
            }),
          })),
        })),
        close: jest.fn(),
        connect: jest.fn(),
      }

      await expect(
        loadEstimates(mockClientWithListError, request),
      ).rejects.toThrow(listError)
    })

    it('creates a new mongo collection if one does not exist', async () => {
      const mockClientWithoutCollection: Partial<mongo.MongoClient> = {
        db: jest.fn().mockImplementation(() => {
          return {
            createCollection: jest.fn(),
            listCollections: jest.fn().mockImplementation(() => {
              return {
                next: jest.fn().mockImplementation((callback) => {
                  callback()
                }),
              }
            }),
            collection: jest.fn().mockImplementation(),
          }
        }),
        close: jest.fn(),
        connect: jest.fn(),
      }
      jest.spyOn(Logger.prototype, 'info').mockImplementation()

      const estimates = await loadEstimates(
        mockClientWithoutCollection,
        request,
      )

      expect(estimates).toEqual([])
    })

    it.each([
      [['cloudProviders', ['test-cloud-providers'], 'cloudProvider']],
      [['accounts', ['test-accounts'], 'accountId']],
      [['services', ['test-services'], 'serviceName']],
      [['regions', ['test-regions'], 'region']],
      [['tags', { 'test-key': 'test-tag' }, 'tags.test-key']],
    ])('determines matching filters', async (filter) => {
      const request: EstimationRequest = {
        startDate: new Date('2022-01-01'),
        endDate: new Date('2022-01-02'),
        skip: 0,
        ignoreCache: false,
        [`${filter[0]}`]: filter[1],
      }

      const estimates = await loadEstimates(mockClient, request)

      const filterValue =
        filter[0] === 'tags' ? filter[1]['test-key'] : filter[1]
      const matchOperator = filter[0] === 'tags' ? '$eq' : '$in'

      // Rows come back one document each and are grouped by timestamp in
      // Node, so no returned document holds a whole day of rows.
      const aggregation = [
        {
          $match: {
            [`${filter[2]}`]: { [matchOperator]: filterValue },
            timestamp: {
              $gte: new Date('2022-01-01T00:00:00.000Z'),
              $lte: new Date('2022-01-02T00:00:00.000Z'),
            },
          },
        },
        { $skip: 0 },
        { $limit: 50000 },
        { $sort: { _id: 1, timestamp: 1 } },
        { $unset: ['_id'] },
      ]

      expect(mockAggregation).toHaveBeenCalledWith(aggregation, {
        allowDiskUse: true,
      })
      expect(estimates).toEqual(expectedEstimates)
    })
  })

  describe('sets estimates', () => {
    const testDate = new Date('2022-01-01')
    const mockEstimates: EstimationResult[] = [
      {
        timestamp: testDate,
        groupBy: GroupBy.day,
        serviceEstimates: [
          {
            cloudProvider: 'aws',
            accountId: '1',
            accountName: 'test-account',
            serviceName: 'test-service',
            kilowattHours: 5,
            co2e: 10,
            cost: 5,
            region: 'test-region',
            usesAverageCPUConstant: false,
          },
          {
            cloudProvider: 'aws',
            accountId: '2',
            accountName: 'test-account-2',
            serviceName: 'test-service-2',
            kilowattHours: 5,
            co2e: 15,
            cost: 8,
            region: 'test-region',
            usesAverageCPUConstant: false,
          },
        ],
        periodStartDate: testDate,
        periodEndDate: testDate,
      },
      {
        timestamp: testDate,
        groupBy: GroupBy.day,
        serviceEstimates: [
          {
            cloudProvider: 'aws',
            accountId: '1',
            accountName: 'test-account',
            serviceName: 'test-service',
            kilowattHours: 5,
            co2e: 10,
            cost: 5,
            region: 'test-region',
            usesAverageCPUConstant: false,
          },
        ],
        periodStartDate: testDate,
        periodEndDate: testDate,
      },
    ]

    beforeEach(() => {
      ;(configLoader as jest.Mock).mockReturnValue({
        ...configLoader(),
        MONGODB_URI: 'test-mongo-uri',
      })
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('successfully sets estimates to a mongoDB collection', async () => {
      const mongoDbCacheManager = new MongoDbCacheManager()

      const mockInsertMany = jest.fn()
      const mockCollection = jest
        .fn()
        .mockImplementation(() => ({ insertMany: mockInsertMany }))

      const mockClient: Partial<mongo.MongoClient> = {
        db: jest.fn().mockImplementation(() => {
          return {
            collection: mockCollection,
          }
        }),
        close: jest.fn(),
        connect: jest.fn(),
      }

      jest
        .spyOn(MongoDbCacheManager, 'createDbConnection')
        .mockImplementation(async () => {
          MongoDbCacheManager.mongoClient = mockClient as mongo.MongoClient
        })

      await MongoDbCacheManager.createDbConnection()
      await mongoDbCacheManager.setEstimates(mockEstimates, 'day')

      // Should insert flat service estimates with timestamp and groupBy appended to each
      const expectedInsertedEstimates = [
        {
          cloudProvider: 'aws',
          accountId: '1',
          accountName: 'test-account',
          serviceName: 'test-service',
          kilowattHours: 5,
          co2e: 10,
          cost: 5,
          region: 'test-region',
          usesAverageCPUConstant: false,
          timestamp: testDate,
          groupBy: GroupBy.day,
        },
        {
          cloudProvider: 'aws',
          accountId: '2',
          accountName: 'test-account-2',
          serviceName: 'test-service-2',
          kilowattHours: 5,
          co2e: 15,
          cost: 8,
          region: 'test-region',
          usesAverageCPUConstant: false,
          timestamp: testDate,
          groupBy: GroupBy.day,
        },
        {
          cloudProvider: 'aws',
          accountId: '1',
          accountName: 'test-account',
          serviceName: 'test-service',
          kilowattHours: 5,
          co2e: 10,
          cost: 5,
          region: 'test-region',
          usesAverageCPUConstant: false,
          timestamp: testDate,
          groupBy: GroupBy.day,
        },
      ]

      expect(mockCollection).toHaveBeenCalledWith('estimates-by-day')
      expect(mockInsertMany).toHaveBeenCalledWith(expectedInsertedEstimates)
    })
  })
  describe('gets missing dates', () => {
    let mockClient: Partial<mongo.MongoClient>
    const testDate = new Date('2022-01-01')
    const mockMissingDates: Moment[] = [
      moment.utc('2022-01-01'),
      moment.utc('2022-01-02'),
    ]

    const request = {
      startDate: testDate,
      endDate: new Date('2022-01-02'),
      ignoreCache: false,
      groupBy: 'day',
      skip: 0,
      limit: 1,
    }

    beforeEach(() => {
      mockClient = {
        db: jest.fn().mockImplementation(() => ({
          listCollections: jest.fn().mockImplementation(() => ({
            next: jest.fn().mockImplementation((callback) => {
              callback(undefined, { name: 'test-collection' })
            }),
          })),
          collection: jest.fn().mockImplementation(() => ({
            countDocuments: jest.fn().mockResolvedValue([{ dates: [] }]),
            aggregate: mockAggregation.mockImplementation(() => ({
              toArray: jest.fn().mockResolvedValue([{ dates: ['2022-01-01'] }]),
            })),
          })),
        })),
        close: jest.fn(),
        connect: jest.fn(),
      }
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('loads dates from mongo to calculate missing dates from request', async () => {
      const mongoDbCacheManager = new MongoDbCacheManager()

      jest
        .spyOn(MongoDbCacheManager, 'createDbConnection')
        .mockImplementation(async () => {
          MongoDbCacheManager.mongoClient = mockClient as mongo.MongoClient
        })

      mockGetDates.mockReturnValue(mockMissingDates)
      const aggregation = [
        {
          $group: {
            _id: null,
            dates: {
              $addToSet: {
                $dateToString: {
                  date: '$timestamp',
                  format: '%Y-%m-%d',
                },
              },
            },
          },
        },
      ]

      await MongoDbCacheManager.createDbConnection()
      const missingDates = await mongoDbCacheManager.getMissingDates(
        request,
        'day',
      )

      expect(mockAggregation).toHaveBeenCalledWith(aggregation, {
        allowDiskUse: true,
      })
      expect(JSON.stringify(missingDates)).toEqual(
        JSON.stringify([moment.utc(new Date('2022-01-02'))]),
      )
    })

    it('returns all dates in range for missing dates if ignoreCache=true', async () => {
      const mongoDbCacheManager = new MongoDbCacheManager()

      const newRequest = {
        ...request,
        ignoreCache: true,
      }

      mockGetDates.mockReturnValue(mockMissingDates)

      const missingDates = await mongoDbCacheManager.getMissingDates(
        newRequest,
        'day',
      )

      expect(JSON.stringify(missingDates)).toEqual(
        JSON.stringify(mockMissingDates),
      )
    })

    it('returns only the missing dates of a specific cloud provider when configured', async () => {
      const mongoDbCacheManager = new MongoDbCacheManager()

      jest
        .spyOn(MongoDbCacheManager, 'createDbConnection')
        .mockImplementation(async () => {
          MongoDbCacheManager.mongoClient = mockClient as mongo.MongoClient
        })

      mockGetDates.mockReturnValue(mockMissingDates)
      const newRequest = {
        ...request,
        cloudProviderToSeed: 'AWS',
      }
      const aggregation = [
        {
          $group: {
            _id: null,
            dates: {
              $addToSet: {
                $cond: {
                  if: {
                    $eq: ['$cloudProvider', newRequest.cloudProviderToSeed],
                  },
                  then: '$timestamp',
                  else: '$$REMOVE',
                },
              },
            },
          },
        },
      ]

      await MongoDbCacheManager.createDbConnection()
      const missingDates = await mongoDbCacheManager.getMissingDates(
        newRequest,
        'day',
      )

      expect(mockAggregation).toHaveBeenCalledWith(aggregation, {
        allowDiskUse: true,
      })

      expect(JSON.stringify(missingDates)).toEqual(
        JSON.stringify([moment.utc(new Date('2022-01-02'))]),
      )
    })

    it('hits an error getting missing dates if requested dates is undefined', async () => {
      const mongoDbCacheManager = new MongoDbCacheManager()

      mockGetDates.mockReturnValue(undefined)

      jest.spyOn(Logger.prototype, 'warn').mockImplementation()

      jest
        .spyOn(MongoDbCacheManager, 'createDbConnection')
        .mockImplementation(async () => {
          MongoDbCacheManager.mongoClient = mockClient as mongo.MongoClient
        })

      await MongoDbCacheManager.createDbConnection()
      const missingDates = await mongoDbCacheManager.getMissingDates(
        request,
        'day',
      )

      expect(Logger.prototype.warn).toHaveBeenCalled()
      expect(missingDates).toEqual([])
    })
  })
})
