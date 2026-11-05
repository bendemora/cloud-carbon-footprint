/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { Collection, MongoClient, ServerApiVersion } from 'mongodb'
import { Granularity, IntensityPoint, IntensityStore } from '../types'

export const MONGODB_DATABASE = 'ccf'
export const MONGODB_COLLECTION = 'grid-intensity-points'
/** How long a failed connection is remembered before the store tries again. */
export const MONGODB_RECONNECT_AFTER_MS = 5 * 60 * 1000

/** Documents have the IntensityPoint fields, dates as BSON dates. */
type PointDocument = IntensityPoint

export interface MongoDbIntensityStoreOptions {
  /** Default MONGODB_RECONNECT_AFTER_MS (five minutes). */
  reconnectAfterMs?: number
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number
}

/**
 * The MONGODB store (design section 6.6): collection grid-intensity-points
 * in the ccf database, the database the estimates cache uses. One document
 * per point, unique on source, zone, granularity and period start.
 *
 * Connects on first use. A failed connection (or index creation) is
 * remembered for five minutes: calls in that time fail at once, so a run
 * with MongoDB down fails fast and the resolver carries on without the
 * store. The first call after that connects again, so a long-running API
 * server recovers once MongoDB is back. Call close() at the end of a run.
 */
export class MongoDbIntensityStore implements IntensityStore {
  private collectionPromise?: Promise<Collection<PointDocument>>
  private retryAt?: number
  private readonly reconnectAfterMs: number
  private readonly now: () => number

  constructor(
    private readonly client: MongoClient,
    private readonly databaseName: string = MONGODB_DATABASE,
    options: MongoDbIntensityStoreOptions = {},
  ) {
    this.reconnectAfterMs =
      options.reconnectAfterMs ?? MONGODB_RECONNECT_AFTER_MS
    this.now = options.now ?? Date.now
  }

  /** Same connection options as MongoDbCacheManager in packages/app. */
  static fromConnectionString(
    uri: string,
    credentials?: string,
  ): MongoDbIntensityStore {
    const client = credentials
      ? new MongoClient(uri, {
          sslKey: credentials,
          sslCert: credentials,
          serverApi: ServerApiVersion.v1,
        })
      : new MongoClient(uri)
    return new MongoDbIntensityStore(client)
  }

  async get(
    sourceId: string,
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]> {
    const collection = await this.collection()
    const documents: IntensityPoint[] = await collection
      .find(
        {
          sourceId,
          zoneId,
          granularity,
          periodStart: { $lt: end },
          periodEnd: { $gt: start },
        },
        { projection: { _id: 0 } },
      )
      .sort({ periodStart: 1 })
      .toArray()
    return documents
  }

  async put(points: IntensityPoint[]): Promise<void> {
    if (!points.length) return
    const collection = await this.collection()
    await collection.bulkWrite(
      points.map((point) => ({
        replaceOne: {
          filter: {
            sourceId: point.sourceId,
            zoneId: point.zoneId,
            granularity: point.granularity,
            periodStart: point.periodStart,
          },
          replacement: point,
          upsert: true,
        },
      })),
      { ordered: false },
    )
  }

  /** Removes the source's points retrieved before `olderThan`. */
  async purge(sourceId: string, olderThan: Date): Promise<number> {
    const collection = await this.collection()
    const result = await collection.deleteMany({
      sourceId,
      retrievedAt: { $lt: olderThan },
    })
    return result.deletedCount
  }

  async close(): Promise<void> {
    await this.client.close()
  }

  private collection(): Promise<Collection<PointDocument>> {
    if (this.retryAt !== undefined && this.now() >= this.retryAt) {
      this.collectionPromise = undefined
      this.retryAt = undefined
    }
    this.collectionPromise ??= this.connect()
    return this.collectionPromise
  }

  private async connect(): Promise<Collection<PointDocument>> {
    try {
      await this.client.connect()
      const collection = this.client
        .db(this.databaseName)
        .collection<PointDocument>(MONGODB_COLLECTION)
      await collection.createIndex(
        { sourceId: 1, zoneId: 1, granularity: 1, periodStart: 1 },
        { unique: true },
      )
      return collection
    } catch (error) {
      this.retryAt = this.now() + this.reconnectAfterMs
      throw error
    }
  }
}
