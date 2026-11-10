/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * MongoDbCacheManager against a real MongoDB server. The other tests of the
 * cache manager replace the driver with a fake; these check what the driver
 * and the server really do with a day of 50,000 rows.
 *
 * They are skipped unless MONGODB_LIVE_TESTS holds the address of a
 * throwaway server (no access control), and they never run when CI is set:
 *
 *   docker run -d --name ccf-mongo-live -p 127.0.0.1:27917:27017 mongo:6.0
 *   MONGODB_LIVE_TESTS=mongodb://127.0.0.1:27917 \
 *     yarn workspace @cloud-carbon-footprint/app test MongoDbCacheManager.live
 *   docker rm -f -v ccf-mongo-live
 *
 * They use a database of their own, dropped before and after, never ccf.
 */

import net, { AddressInfo } from 'net'
import { MongoClient } from 'mongodb'
import {
  EstimationResult,
  GroupBy,
  Logger,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import MongoDbCacheManager from '../MongoDbCacheManager'
import { EstimationRequest } from '../CreateValidRequest'

const uri = process.env.CI ? undefined : process.env.MONGODB_LIVE_TESTS
const describeLive = uri ? describe : describe.skip

const DATABASE = 'ccf-live-tests-app'
const COLLECTION = 'estimates-by-day'
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const ROWS = 50000
const PAGE = 20000
const day = new Date('2026-01-01T00:00:00.000Z')
const nextDay = new Date('2026-01-02T00:00:00.000Z')

/** A billing row as the AWS, GCP and Azure paths produce it, with provenance. */
const serviceEstimate = (index: number): ServiceData => ({
  cloudProvider: 'AWS',
  kilowattHours: 0.0123456789012,
  co2e: 0.00000412345678901,
  cost: 1.23456789,
  usesAverageCPUConstant: false,
  accountId: 'live-test-account',
  accountName: 'live-test-account',
  serviceName: `AmazonEC2-${index}`,
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
})

const estimatesOf = (
  timestamp: Date,
  firstIndex: number,
  count: number,
): EstimationResult => ({
  timestamp,
  serviceEstimates: Array.from({ length: count }, (_, offset) =>
    serviceEstimate(firstIndex + offset),
  ),
  periodStartDate: timestamp,
  periodEndDate: timestamp,
  groupBy: GroupBy.day,
})

const names = (estimates: ServiceData[]) =>
  estimates.map((estimate) => estimate.serviceName)

const byName = (estimates: ServiceData[]) =>
  [...estimates].sort((a, b) => (a.serviceName < b.serviceName ? -1 : 1))

/** A local port that nothing listens on. */
const unusedPort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })

describeLive('MongoDbCacheManager against a real MongoDB server', () => {
  jest.setTimeout(120000)

  const firstDay = estimatesOf(day, 0, ROWS)
  const secondDay = estimatesOf(nextDay, ROWS, 3)
  let client: MongoClient
  let manager: MongoDbCacheManager
  /** The _id of each stored row, as a hex string, by service name. */
  let ids: Map<string, string>

  const rows = () => client.db(DATABASE).collection(COLLECTION)
  const request = (
    overrides: Partial<EstimationRequest> = {},
  ): EstimationRequest => ({
    startDate: day,
    endDate: nextDay,
    ignoreCache: false,
    groupBy: 'day',
    ...overrides,
  })
  const load = (overrides?: Partial<EstimationRequest>) =>
    manager.loadEstimates(client.db(DATABASE), COLLECTION, request(overrides))

  /**
   * Whether the rows are in the order loadEstimates sorts them into: by _id.
   * That is the order they were stored in, unless the driver's ObjectId
   * counter wrapped round while they were being stored.
   */
  const inIdOrder = (estimates: ServiceData[]) =>
    estimates.every(
      (estimate, position) =>
        position === 0 ||
        ids.get(estimates[position - 1].serviceName) <
          ids.get(estimate.serviceName),
    )

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'info').mockImplementation()
    client = await new MongoClient(uri).connect()
    MongoDbCacheManager.mongoClient = client
    manager = new MongoDbCacheManager()
    manager.mongoDbName = DATABASE
    await client.db(DATABASE).dropDatabase()

    await manager.setEstimates([firstDay, secondDay], 'day')

    ids = new Map()
    for await (const row of rows().find({}, { projection: { serviceName: 1 } }))
      ids.set(row.serviceName, row._id.toHexString())
  })

  afterAll(async () => {
    await client.db(DATABASE).dropDatabase()
    await client.close()
  })

  it('stores a day of rows that are together too large for one MongoDB document', async () => {
    const [stored] = await rows()
      .aggregate([
        { $match: { timestamp: day } },
        {
          $group: {
            _id: null,
            rows: { $sum: 1 },
            bytes: { $sum: { $bsonSize: '$$ROOT' } },
          },
        },
      ])
      .toArray()

    expect(stored.rows).toBe(ROWS)
    expect(stored.bytes).toBeGreaterThan(MAX_DOCUMENT_BYTES)
  })

  it('cannot have those rows grouped into one document by the server', async () => {
    // What loadEstimates asked for until it grouped the rows in Node instead.
    const groupedByTheServer = rows()
      .aggregate(
        [
          { $match: { timestamp: day } },
          {
            $group: {
              _id: '$timestamp',
              serviceEstimates: { $push: '$$ROOT' },
            },
          },
        ],
        { allowDiskUse: true },
      )
      .toArray()

    await expect(groupedByTheServer).rejects.toMatchObject({
      codeName: 'BSONObjectTooLarge',
    })
  })

  it('loads every row of the day as one result', async () => {
    const estimates = await load({ endDate: day })

    expect(estimates).toHaveLength(1)
    expect(estimates[0].timestamp).toEqual(day)
    expect(estimates[0].groupBy).toBe('day')
    expect(estimates[0].serviceEstimates).toHaveLength(ROWS)
    expect(byName(estimates[0].serviceEstimates)).toEqual(
      byName(firstDay.serviceEstimates),
    )
    expect(inIdOrder(estimates[0].serviceEstimates)).toBe(true)
    expect(
      await manager.getEstimates(request({ endDate: day }), 'day'),
    ).toEqual(estimates)
  })

  it('pages through the rows without losing or repeating any', async () => {
    // Five pages: the rows fill two and part of a third.
    const pages: EstimationResult[][] = []
    for (let skip = 0; skip < 5 * PAGE; skip += PAGE)
      pages.push(await load({ skip, limit: PAGE }))

    // The third page holds the end of the first day and all of the second.
    expect(
      pages.map((page) =>
        page.map((result) => [
          result.timestamp,
          result.serviceEstimates.length,
        ]),
      ),
    ).toEqual([
      [[day, PAGE]],
      [[day, PAGE]],
      [
        [day, ROWS - 2 * PAGE],
        [nextDay, 3],
      ],
      [],
      [],
    ])
    const results = pages.flat()
    expect(results.every((result) => inIdOrder(result.serviceEstimates))).toBe(
      true,
    )
    expect(
      names(results.flatMap((result) => result.serviceEstimates)).sort(),
    ).toEqual(
      names([
        ...firstDay.serviceEstimates,
        ...secondDay.serviceEstimates,
      ]).sort(),
    )
  })

  it('fails to get the estimates when the server cannot be reached', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation()
    const unreachable = new MongoClient(
      `mongodb://127.0.0.1:${await unusedPort()}`,
      { serverSelectionTimeoutMS: 500 },
    )
    MongoDbCacheManager.mongoClient = unreachable

    try {
      await expect(
        manager.getEstimates(request(), 'day'),
      ).rejects.toMatchObject({ name: 'MongoServerSelectionError' })
    } finally {
      MongoDbCacheManager.mongoClient = client
      await unreachable.close()
    }
  })
})
