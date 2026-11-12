/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * MongoDbIntensityStore against a real MongoDB server. The other tests of
 * the store replace the driver with a fake; these check what the driver and
 * the server really do.
 *
 * They are skipped unless MONGODB_LIVE_TESTS holds the address of a
 * throwaway server (one host, no access control), and they never run when CI
 * is set:
 *
 *   docker run -d --name ccf-mongo-live -p 127.0.0.1:27917:27017 mongo:6.0
 *   MONGODB_LIVE_TESTS=mongodb://127.0.0.1:27917 \
 *     yarn workspace @cloud-carbon-footprint/grid-intensity test MongoDbIntensityStore.live
 *   docker rm -f -v ccf-mongo-live
 *
 * They use a database of their own, dropped before and after, never ccf.
 */

import net, { AddressInfo } from 'net'
import { MongoClient } from 'mongodb'
import {
  MONGODB_COLLECTION,
  MONGODB_RECONNECT_AFTER_MS,
  MongoDbIntensityStore,
} from '../stores/MongoDbIntensityStore'
import { IntensityPoint } from '../types'

const uri = process.env.CI ? undefined : process.env.MONGODB_LIVE_TESTS
const describeLive = uri ? describe : describe.skip

const DATABASE = 'ccf-live-tests-grid-intensity'
const HOUR_MS = 60 * 60 * 1000
const START = Date.parse('2026-01-01T00:00:00.000Z')
const utc = (iso: string) => new Date(iso)

const hourlyPoints = (
  count: number,
  overrides: Partial<IntensityPoint> = {},
): IntensityPoint[] =>
  Array.from({ length: count }, (_, hour) => ({
    zoneId: 'GB',
    periodStart: new Date(START + hour * HOUR_MS),
    periodEnd: new Date(START + (hour + 1) * HOUR_MS),
    granularity: 'hour',
    gCO2ePerKWh: 100.125 + hour,
    basis: 'location-consumption',
    factorType: 'lifecycle',
    isEstimated: hour % 7 === 0,
    sourceId: 'entsoe',
    retrievedAt: utc('2026-11-01T00:00:00.000Z'),
    ...overrides,
  }))

/**
 * A local port in front of the MongoDB server that refuses connections until
 * open() is called: a server that is down, and then comes back.
 */
const closedGate = async (host: string, port: number) => {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host)
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on('error', () => undefined)
      socket.on('close', () => {
        sockets.delete(socket)
        client.destroy()
        upstream.destroy()
      })
    }
    client.pipe(upstream).pipe(client)
  })
  const listen = (onPort: number) =>
    new Promise<number>((resolve) =>
      server.listen(onPort, '127.0.0.1', () =>
        resolve((server.address() as AddressInfo).port),
      ),
    )
  const stop = () => new Promise((resolve) => server.close(resolve))
  // Take a free port and give it back, so that nothing listens on it yet.
  const gatePort = await listen(0)
  await stop()
  return {
    port: gatePort,
    open: () => listen(gatePort),
    close: async () => {
      sockets.forEach((socket) => socket.destroy())
      await stop()
    },
  }
}

describeLive('MongoDbIntensityStore against a real MongoDB server', () => {
  jest.setTimeout(60000)

  // Marks the connections of the store under test on the server.
  const appName = `ccf-live-tests-${process.pid}`
  let admin: MongoClient
  let store: MongoDbIntensityStore

  const stored = () => admin.db(DATABASE).collection(MONGODB_COLLECTION)
  const twoDays = (from: MongoDbIntensityStore = store) =>
    from.get(
      'entsoe',
      'GB',
      new Date(START),
      new Date(START + 48 * HOUR_MS),
      'hour',
    )

  beforeAll(async () => {
    admin = await new MongoClient(uri).connect()
  })

  beforeEach(async () => {
    await admin.db(DATABASE).dropDatabase()
    store = new MongoDbIntensityStore(
      new MongoClient(uri, { appName }),
      DATABASE,
    )
  })

  afterEach(async () => {
    await store.close()
  })

  afterAll(async () => {
    await admin.db(DATABASE).dropDatabase()
    await admin.close()
  })

  it('reads back what it stored, with dates, in period order and without _id', async () => {
    const points = hourlyPoints(48)

    await store.put([...points].reverse())

    expect(await twoDays()).toEqual(points)
    // put() leaves the points it was given as they were.
    expect(points.some((point) => '_id' in point)).toBe(false)
    expect(await stored().countDocuments()).toBe(48)
  })

  it('selects the points that overlap the requested period', async () => {
    await store.put(hourlyPoints(48))

    const points = await store.get(
      'entsoe',
      'GB',
      new Date(START + 2.5 * HOUR_MS),
      new Date(START + 5 * HOUR_MS),
      'hour',
    )

    expect(points.map((point) => point.periodStart.toISOString())).toEqual([
      '2026-01-01T02:00:00.000Z',
      '2026-01-01T03:00:00.000Z',
      '2026-01-01T04:00:00.000Z',
    ])
  })

  it('keeps one document per source, zone, granularity and period start', async () => {
    const points = hourlyPoints(48)
    const fetchedAgain = points.map((point) => ({
      ...point,
      gCO2ePerKWh: point.gCO2ePerKWh + 1,
      retrievedAt: utc('2026-11-05T00:00:00.000Z'),
    }))

    await store.put(points)
    await store.put(fetchedAgain)
    await store.put(fetchedAgain)

    expect(await stored().countDocuments()).toBe(48)
    expect(await twoDays()).toEqual(fetchedAgain)
    expect(await stored().indexes()).toContainEqual(
      expect.objectContaining({
        name: 'sourceId_1_zoneId_1_granularity_1_periodStart_1',
        unique: true,
      }),
    )
    // The server refuses a second document, not only the store's upsert.
    await expect(stored().insertOne({ ...points[0] })).rejects.toMatchObject({
      code: 11000,
    })
  })

  it('takes the same new points from two stores at once', async () => {
    const other = new MongoDbIntensityStore(new MongoClient(uri), DATABASE)
    const points = hourlyPoints(500)

    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, turn) =>
          (turn % 2 ? store : other).put(points.map((point) => ({ ...point }))),
        ),
      )
    } finally {
      await other.close()
    }

    expect(await stored().countDocuments()).toBe(500)
  })

  it('purges only the points of a source retrieved before the cut-off', async () => {
    await store.put([
      ...hourlyPoints(24),
      ...hourlyPoints(24, {
        zoneId: 'DE',
        retrievedAt: utc('2026-11-03T00:00:00.000Z'),
      }),
      ...hourlyPoints(24, {
        sourceId: 'neso',
        retrievedAt: utc('2026-10-01T00:00:00.000Z'),
      }),
    ])

    // Retrieved at the cut-off is not before it.
    await expect(
      store.purge('entsoe', utc('2026-11-01T00:00:00.000Z')),
    ).resolves.toBe(0)
    await expect(
      store.purge('entsoe', utc('2026-11-02T00:00:00.000Z')),
    ).resolves.toBe(24)
    expect(await stored().countDocuments({ sourceId: 'entsoe' })).toBe(24)
    expect(await stored().countDocuments({ sourceId: 'neso' })).toBe(24)
  })

  it('fails at once after a failed connection, then connects when the retry interval is over', async () => {
    await store.put(hourlyPoints(48))
    const [server] = new MongoClient(uri).options.hosts
    const gate = await closedGate(server.host, server.port)
    const client = new MongoClient(`mongodb://127.0.0.1:${gate.port}`, {
      directConnection: true,
      serverSelectionTimeoutMS: 500,
    })
    const connect = jest.spyOn(client, 'connect')
    let now = 0
    const late = new MongoDbIntensityStore(client, DATABASE, {
      now: () => now,
    })

    try {
      // Nothing listens: the driver gives up after its selection timeout.
      await expect(twoDays(late)).rejects.toThrow()
      await expect(twoDays(late)).rejects.toThrow()
      expect(connect).toHaveBeenCalledTimes(1)

      // The server can be reached now, but the failure is still remembered.
      await gate.open()
      now = MONGODB_RECONNECT_AFTER_MS - 1
      await expect(twoDays(late)).rejects.toThrow()
      expect(connect).toHaveBeenCalledTimes(1)

      // The same client connects again: the driver builds a new topology.
      now = MONGODB_RECONNECT_AFTER_MS
      await expect(twoDays(late)).resolves.toHaveLength(48)
      expect(connect).toHaveBeenCalledTimes(2)
    } finally {
      await late.close()
      await gate.close()
    }
  })

  it('ends its server connections when it is closed', async () => {
    const connections = async () =>
      (
        await admin
          .db('admin')
          .aggregate([
            { $currentOp: { allUsers: true, idleConnections: true } },
            { $match: { appName } },
          ])
          .toArray()
      ).length
    await store.put(hourlyPoints(1))
    expect(await connections()).toBeGreaterThan(0)

    await store.close()

    let open = await connections()
    for (let tries = 0; open > 0 && tries < 40; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      open = await connections()
    }
    expect(open).toBe(0)
  })
})
