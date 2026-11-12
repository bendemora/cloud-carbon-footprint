/*
 * © 2021 Thoughtworks, Inc.
 */

import moment, { Moment } from 'moment'
import { MongoClient, ServerApiVersion } from 'mongodb'
import {
  configLoader,
  EstimationResult,
  Logger,
} from '@cloud-carbon-footprint/common'
import CacheManager, { CachedPeriod, DateRange } from './CacheManager'
import { EstimationRequest } from './CreateValidRequest'
import { getDatesWithinRequestTimeFrame, QUALITY_TIERS } from './common/helpers'

export default class MongoDbCacheManager extends CacheManager {
  static mongoClient: MongoClient
  mongoDbName: string

  constructor() {
    super()
    this.mongoDbName = 'ccf'
  }

  /**
   * Creates a connection to the MongoDB client using the provided URI and any credentials.
   * If no credentials are provided, the connection will be made without SSL.
   * This function needs to be invoked before using this MongoDbCacheManager and making any requests to the MongoDB client.
   * @returns {Promise<void>} A Promise that resolves when the connection is established.
   */
  static async createDbConnection() {
    const logger = new Logger('MongoDB')
    const mongoURI = configLoader().MONGODB.URI
    const mongoCredentials = configLoader().MONGODB.CREDENTIALS

    if (mongoCredentials && mongoURI) {
      MongoDbCacheManager.mongoClient = new MongoClient(mongoURI, {
        sslKey: mongoCredentials,
        sslCert: mongoCredentials,
        serverApi: ServerApiVersion.v1,
      })
    } else if (mongoURI) {
      MongoDbCacheManager.mongoClient = new MongoClient(mongoURI)
    } else {
      logger.error(
        'There was an error connecting to the MongoDB client',
        new Error('Please provide a valid URI'),
      )
    }

    try {
      await MongoDbCacheManager.mongoClient.connect()
      logger.info('Successfully connected to the MongoDB client')
    } catch (error) {
      logger.error('There was an error connecting to the MongoDB client', error)
    }
  }

  async loadEstimates(
    db: any,
    collectionName: string,
    request: EstimationRequest,
  ): Promise<EstimationResult[]> {
    const unitOfTime =
      request.groupBy === 'week'
        ? 'isoWeek'
        : (request.groupBy as moment.unitOfTime.StartOf)
    const startDate = new Date(
      moment.utc(request.startDate).startOf(unitOfTime) as unknown as Date,
    )
    const endDate = new Date(request.endDate)

    const filters = this.createAggregationFilters(request, startDate, endDate)
    const aggregationStages = this.createAggregationStages(request, filters)

    return new Promise(function (resolve, reject) {
      db.listCollections({ name: collectionName }).next(
        async (err: Error, collectionInfo: any) => {
          if (err) return reject(err)
          if (collectionInfo) {
            const estimates = db.collection(collectionName)

            groupRowsByTimestamp(
              estimates.aggregate(aggregationStages, { allowDiskUse: true }),
            ).then(resolve, reject)
          } else {
            // The collection does not exist - so we can create it
            db.createCollection(collectionName)
            resolve([])
          }
        },
      )
    })
  }

  async getEstimates(
    request: EstimationRequest,
    grouping: string,
  ): Promise<EstimationResult[]> {
    let savedEstimates: EstimationResult[] = []
    try {
      // Specify a database to query
      const collectionName = `estimates-by-${grouping}`
      const database = MongoDbCacheManager.mongoClient.db(this.mongoDbName)

      const estimates = await this.loadEstimates(
        database,
        collectionName,
        request,
      )

      savedEstimates = estimates ?? []
    } catch (e) {
      // Fail the request rather than answer with no estimates: the dates are
      // already marked as cached, so an empty answer would never be retried.
      this.cacheLogger.error(
        'There was an error getting estimates from MongoDB',
        e,
      )
      throw e
    }
    return savedEstimates
  }

  async setEstimates(
    estimates: EstimationResult[],
    grouping: string,
  ): Promise<void> {
    try {
      const collectionName = `estimates-by-${grouping}`
      const database = MongoDbCacheManager.mongoClient.db(this.mongoDbName)
      const collection = database.collection(collectionName)

      await collection.insertMany(rowsOf(estimates))
    } catch (e) {
      this.cacheLogger.warn(
        `There was an error setting estimates from MongoDB: ${e.message}`,
      )
    }
  }

  /**
   * Deletes the rows of the given periods and providers, then inserts the
   * new rows. The two steps are not a transaction (ADR 0025). If the insert
   * fails after the delete, the call fails and the periods are missing from
   * the cache, so the next footprint request estimates them again. The rows
   * are deleted first so that a failure between the two steps cannot leave a
   * period with both its old and its new rows, which would count it twice.
   */
  async replaceEstimates(
    estimates: EstimationResult[],
    grouping: string,
    cloudProviders?: string[],
  ): Promise<void> {
    if (!estimates.length) return
    const collection = this.connectedDatabase().collection(
      `estimates-by-${grouping}`,
    )

    const timestamps = [
      ...new Set(
        estimates.map(({ timestamp }) => new Date(timestamp).getTime()),
      ),
    ].map((time) => new Date(time))
    await collection.deleteMany({
      timestamp: { $in: timestamps },
      ...(cloudProviders && {
        cloudProvider: { $in: cloudProviders.map(matchingAnyCase) },
      }),
    })

    const rows = rowsOf(estimates)
    if (rows.length) await collection.insertMany(rows)
  }

  /**
   * One query over the rows of the grouping. It answers with one document
   * for each period, cloud provider and region, which are put together by
   * period here. The worst tier of a provider and region is the greatest of
   * the tiers of its rows, as text: A is the best tier and D the worst, and
   * rows without provenance have none. A collection that does not exist has
   * no rows, and reading it does not create it (loadEstimates does). No
   * index serves the query yet; ADR 0025 expects one to be needed with
   * hourly grouping.
   */
  async getCachedPeriods(
    grouping: string,
    range?: DateRange,
  ): Promise<CachedPeriod[]> {
    const collection = this.connectedDatabase().collection(
      `estimates-by-${grouping}`,
    )
    const rowGroups = await collection
      .aggregate(
        [
          ...(range
            ? [
                {
                  $match: {
                    timestamp: { $gte: range.startDate, $lte: range.endDate },
                  },
                },
              ]
            : []),
          {
            $group: {
              _id: {
                timestamp: '$timestamp',
                cloudProvider: '$cloudProvider',
                region: '$region',
              },
              provisional: {
                $max: {
                  $cond: [{ $eq: ['$provenance.isProvisional', true] }, 1, 0],
                },
              },
              worstTier: { $max: '$provenance.qualityTier' },
            },
          },
          { $sort: { '_id.timestamp': 1 } },
        ],
        { allowDiskUse: true },
      )
      .toArray()

    const periods = new Map<number, CachedPeriod>()
    for (const { _id, provisional, worstTier } of rowGroups) {
      const time = new Date(_id.timestamp).getTime()
      const period = periods.get(time) ?? {
        timestamp: new Date(time),
        isProvisional: false,
        worstTiers: [],
      }
      period.isProvisional ||= provisional === 1
      if (QUALITY_TIERS.includes(worstTier))
        period.worstTiers.push({
          cloudProvider: _id.cloudProvider,
          region: _id.region,
          qualityTier: worstTier,
        })
      periods.set(time, period)
    }
    return [...periods.values()]
  }

  locationOf(grouping: string): string {
    return `MongoDB collection ${this.mongoDbName}.estimates-by-${grouping}`
  }

  /**
   * The database, for replaceEstimates and getCachedPeriods. They fail with
   * a message that says so when createDbConnection was not called or could
   * not create a client.
   */
  private connectedDatabase() {
    if (!MongoDbCacheManager.mongoClient)
      throw new Error(
        'There is no connection to MongoDB. Check MONGODB_URI and that the connection is created before the estimates cache is used.',
      )
    return MongoDbCacheManager.mongoClient.db(this.mongoDbName)
  }

  async getMissingDates(
    request: EstimationRequest,
    grouping: string,
  ): Promise<Moment[]> {
    this.cacheLogger.info('Using mongo database...')
    const requestedDates = getDatesWithinRequestTimeFrame(grouping, request)

    if (request.ignoreCache) {
      return requestedDates
    }

    try {
      const collectionName = `estimates-by-${grouping}`
      const database = MongoDbCacheManager.mongoClient.db(this.mongoDbName)

      const aggResult: any = await new Promise((resolve, reject) => {
        database
          .listCollections({ name: collectionName })
          .next(async (err: Error, collectionInfo: any) => {
            // Nothing handles a rejection of this callback's own promise, and
            // an unhandled rejection ends the process. So a failure goes to
            // reject(), and no query runs after one.
            if (err) return reject(err)

            if (!collectionInfo) {
              resolve([{ dates: [] }])
            }

            const estimates = database.collection(collectionName)
            await estimates.countDocuments((err, count) => {
              if (!err && count === 0) {
                resolve([{ dates: [] }])
              }
            })

            let addToSet: unknown = {
              $dateToString: {
                date: '$timestamp',
                format: '%Y-%m-%d',
              },
            }

            if (request.cloudProviderToSeed) {
              addToSet = {
                $cond: {
                  if: {
                    $eq: ['$cloudProvider', request.cloudProviderToSeed],
                  },
                  then: '$timestamp',
                  else: '$$REMOVE',
                },
              }
            }

            estimates
              .aggregate(
                [
                  {
                    $group: {
                      _id: null,
                      dates: {
                        $addToSet: addToSet,
                      },
                    },
                  },
                ],
                { allowDiskUse: true },
              )
              .toArray()
              .then(resolve, reject)
          })
      })

      // $group returns no document for an empty collection: nothing is
      // cached. The countDocuments check above gives the same answer only
      // when it answers before the aggregation does.
      const cachedDates = aggResult[0]?.dates ?? []
      const missingDates = requestedDates.filter((a) => {
        const index = cachedDates.findIndex((cachedDate: string) =>
          moment.utc(cachedDate).isSame(a),
        )
        return index < 0
      })

      return missingDates.map((date: Moment) => {
        return date
      })
    } catch (e) {
      this.cacheLogger.warn(
        `There was an error getting missing dates from MongoDB: ${e.message}`,
      )
      return []
    }
  }

  private createAggregationFilters(
    request: EstimationRequest,
    startDate: Date,
    endDate: Date,
  ) {
    const { cloudProviders, accounts, services, regions, tags } = request
    const filterTable = {
      cloudProvider: cloudProviders,
      accountId: accounts,
      serviceName: services,
      region: regions,
    }
    let aggregationFilters = {
      timestamp: { $gte: startDate, $lte: endDate },
    }

    for (const [key, value] of Object.entries(filterTable)) {
      if (value && value.length > 0) {
        aggregationFilters = {
          [key]: { $in: value },
          ...aggregationFilters,
        }
      }
    }

    if (tags && Object.entries(tags)[0])
      for (const [key, value] of Object.entries(tags)) {
        aggregationFilters = {
          [`tags.${key}`]: { $eq: value },
          ...aggregationFilters,
        }
      }

    return aggregationFilters
  }

  private createAggregationStages(
    request: EstimationRequest,
    filters: unknown,
  ) {
    // Init with pre-query stages
    const aggregationStages: unknown[] = [
      {
        $match: filters,
      },
    ]

    // Optionally build pagination stage
    if (!isNaN(request.skip)) aggregationStages.push({ $skip: request.skip })

    if (request.skip || request.limit) {
      const skip = request.skip || 0
      const limitMsg = request.skip + request.limit || request.limit || 'end'
      this.cacheLogger.info(`Paginating documents: ${skip} to ${limitMsg}`)
    }

    // Add remaining post-query stages. Rows are returned one document each
    // and grouped by timestamp in groupRowsByTimestamp: grouping them on the
    // server would put every row of a timestamp into one document, which
    // fails once that document passes MongoDB's 16 MiB limit.
    aggregationStages.push(
      {
        $limit: isNaN(request.limit) ? 50000 : request.limit,
      },
      {
        $sort: {
          timestamp: 1,
          _id: 1,
        },
      },
      {
        $unset: ['_id'],
      },
    )

    return aggregationStages
  }
}

/**
 * The rows the estimates are stored as: one document for each service
 * estimate, with the timestamp and groupBy of its EstimationResult.
 */
const rowsOf = (estimates: EstimationResult[]): any[] => {
  const rows: any[] = []
  estimates.forEach((estimate) => {
    estimate.serviceEstimates.forEach((serviceEstimate) => {
      const newDocument = {
        ...serviceEstimate,
        timestamp: estimate['timestamp'],
        groupBy: estimate['groupBy'],
      }
      rows.push(newDocument)
    })
  })
  return rows
}

/** A pattern that matches the provider name and nothing else, in any case. */
const matchingAnyCase = (cloudProvider: string): RegExp =>
  new RegExp(`^${cloudProvider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')

/**
 * Builds one EstimationResult per timestamp from the stored rows, in the
 * order the timestamps first appear. Each row is a service estimate with the
 * timestamp and groupBy of its EstimationResult, as setEstimates stores it.
 * The cursor is read in batches, so no single document holds a whole period.
 */
const groupRowsByTimestamp = async (
  rows: AsyncIterable<any>,
): Promise<EstimationResult[]> => {
  const resultsByTimestamp = new Map<number, EstimationResult>()
  for await (const { timestamp, groupBy, ...serviceEstimate } of rows) {
    const key = new Date(timestamp).getTime()
    let result = resultsByTimestamp.get(key)
    if (!result) {
      result = { timestamp, serviceEstimates: [], groupBy } as EstimationResult
      resultsByTimestamp.set(key, result)
    }
    result.serviceEstimates.push(serviceEstimate)
  }
  return [...resultsByTimestamp.values()]
}
