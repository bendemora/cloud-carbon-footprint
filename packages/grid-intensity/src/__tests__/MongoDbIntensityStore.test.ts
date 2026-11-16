/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { MongoClient } from 'mongodb'
import {
  MONGODB_COLLECTION,
  MongoDbIntensityStore,
} from '../stores/MongoDbIntensityStore'
import { IntensityPoint } from '../types'

jest.mock('mongodb', () => ({
  MongoClient: jest.fn(),
  ServerApiVersion: { v1: '1' },
}))

const utc = (iso: string) => new Date(iso)

const point = (overrides: Partial<IntensityPoint> = {}): IntensityPoint => ({
  zoneId: 'GB',
  periodStart: utc('2026-01-01T00:00:00.000Z'),
  periodEnd: utc('2026-01-01T01:00:00.000Z'),
  granularity: 'hour',
  gCO2ePerKWh: 100,
  basis: 'location-consumption',
  factorType: 'lifecycle',
  isEstimated: false,
  sourceId: 'entsoe',
  retrievedAt: utc('2026-11-01T00:00:00.000Z'),
  ...overrides,
})

const fakeClient = (documents: unknown[] = []) => {
  const toArray = jest.fn().mockResolvedValue(documents)
  const sort = jest.fn().mockReturnValue({ toArray })
  const collection = {
    createIndex: jest.fn().mockResolvedValue('index'),
    find: jest.fn().mockReturnValue({ sort }),
    bulkWrite: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 3 }),
  }
  const db = { collection: jest.fn().mockReturnValue(collection) }
  const client = {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    db: jest.fn().mockReturnValue(db),
  }
  return { client, db, collection, sort }
}

const storeWith = (client: ReturnType<typeof fakeClient>['client']) =>
  new MongoDbIntensityStore(client as unknown as MongoClient)

describe('MongoDbIntensityStore', () => {
  afterEach(() => jest.clearAllMocks())

  it('reads overlapping points of one series in period order, without _id', async () => {
    const stored = point()
    const { client, db, collection, sort } = fakeClient([stored])
    const points = await storeWith(client).get(
      'entsoe',
      'GB',
      utc('2026-01-01T00:00:00.000Z'),
      utc('2026-01-02T00:00:00.000Z'),
      'hour',
    )
    expect(client.db).toHaveBeenCalledWith('ccf')
    expect(db.collection).toHaveBeenCalledWith(MONGODB_COLLECTION)
    expect(collection.find).toHaveBeenCalledWith(
      {
        sourceId: 'entsoe',
        zoneId: 'GB',
        granularity: 'hour',
        periodStart: { $lt: utc('2026-01-02T00:00:00.000Z') },
        periodEnd: { $gt: utc('2026-01-01T00:00:00.000Z') },
      },
      { projection: { _id: 0 } },
    )
    expect(sort).toHaveBeenCalledWith({ periodStart: 1 })
    expect(points).toEqual([stored])
  })

  it('upserts each point by source, zone, granularity and period start', async () => {
    const { client, collection } = fakeClient()
    const stored = point()
    await storeWith(client).put([stored])
    expect(collection.bulkWrite).toHaveBeenCalledWith(
      [
        {
          replaceOne: {
            filter: {
              sourceId: 'entsoe',
              zoneId: 'GB',
              granularity: 'hour',
              periodStart: stored.periodStart,
            },
            replacement: stored,
            upsert: true,
          },
        },
      ],
      { ordered: false },
    )
  })

  it('does not connect to store an empty list', async () => {
    const { client, collection } = fakeClient()
    await storeWith(client).put([])
    expect(client.connect).not.toHaveBeenCalled()
    expect(collection.bulkWrite).not.toHaveBeenCalled()
  })

  it('purges points of a source retrieved before the cut-off', async () => {
    const { client, collection } = fakeClient()
    const cutOff = utc('2026-11-01T00:00:00.000Z')
    await expect(storeWith(client).purge('neso', cutOff)).resolves.toBe(3)
    expect(collection.deleteMany).toHaveBeenCalledWith({
      sourceId: 'neso',
      retrievedAt: { $lt: cutOff },
    })
  })

  it('connects and creates the unique index once', async () => {
    const { client, collection } = fakeClient()
    const store = storeWith(client)
    await store.put([point()])
    await store.get(
      'entsoe',
      'GB',
      utc('2026-01-01'),
      utc('2026-01-02'),
      'hour',
    )
    await store.purge('entsoe', utc('2026-11-01'))
    expect(client.connect).toHaveBeenCalledTimes(1)
    expect(collection.createIndex).toHaveBeenCalledTimes(1)
    expect(collection.createIndex).toHaveBeenCalledWith(
      { sourceId: 1, zoneId: 1, granularity: 1, periodStart: 1 },
      { unique: true },
    )
  })

  it('fails fast after a failed connection instead of reconnecting on every call', async () => {
    const { client } = fakeClient()
    client.connect.mockRejectedValue(new Error('ECONNREFUSED'))
    const store = storeWith(client)
    await expect(store.purge('neso', utc('2026-11-01'))).rejects.toThrow(
      'ECONNREFUSED',
    )
    await expect(store.purge('neso', utc('2026-11-01'))).rejects.toThrow(
      'ECONNREFUSED',
    )
    expect(client.connect).toHaveBeenCalledTimes(1)
  })

  it('connects again once five minutes have passed since a failed connection', async () => {
    const { client } = fakeClient()
    client.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    let now = 0
    const store = new MongoDbIntensityStore(
      client as unknown as MongoClient,
      'ccf',
      { now: () => now },
    )
    const purge = () => store.purge('neso', utc('2026-11-01'))
    await expect(purge()).rejects.toThrow('ECONNREFUSED')
    now += 4 * 60 * 1000
    await expect(purge()).rejects.toThrow('ECONNREFUSED')
    expect(client.connect).toHaveBeenCalledTimes(1)

    now += 60 * 1000
    await expect(purge()).resolves.toBe(3)
    await expect(purge()).resolves.toBe(3)
    expect(client.connect).toHaveBeenCalledTimes(2)
  })

  it('also retries after a failure to create the index', async () => {
    const { client, collection } = fakeClient()
    collection.createIndex.mockRejectedValueOnce(new Error('not authorized'))
    let now = 0
    const store = new MongoDbIntensityStore(
      client as unknown as MongoClient,
      'ccf',
      { now: () => now, reconnectAfterMs: 1000 },
    )
    await expect(store.put([point()])).rejects.toThrow('not authorized')
    now += 1000
    await expect(store.put([point()])).resolves.toBeUndefined()
    expect(collection.createIndex).toHaveBeenCalledTimes(2)
  })

  it('closes the client', async () => {
    const { client } = fakeClient()
    await storeWith(client).close()
    expect(client.close).toHaveBeenCalled()
  })

  describe('fromConnectionString', () => {
    it('creates a client from the URI', () => {
      MongoDbIntensityStore.fromConnectionString('mongodb://localhost:27017')
      expect(MongoClient).toHaveBeenCalledWith('mongodb://localhost:27017')
    })

    it('uses the credentials file for TLS, as the estimates cache does', () => {
      MongoDbIntensityStore.fromConnectionString(
        'mongodb+srv://cluster.example.net',
        '/run/secrets/mongo.pem',
      )
      expect(MongoClient).toHaveBeenCalledWith(
        'mongodb+srv://cluster.example.net',
        {
          sslKey: '/run/secrets/mongo.pem',
          sslCert: '/run/secrets/mongo.pem',
          serverApi: '1',
        },
      )
    })
  })
})
