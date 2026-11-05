/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { Collection, MongoClient, ServerApiVersion } from 'mongodb'
import { Granularity, IntensityPoint, IntensityStore } from '../types'

export const MONGODB_DATABASE = 'ccf'
export const MONGODB_COLLECTION = 'grid-intensity-points'

/** Documents have the IntensityPoint fields, dates as BSON dates. */
type PointDocument = IntensityPoint

/**
 * The MONGODB store (design section 6.6): collection grid-intensity-points
 * in the ccf database, the database the estimates cache uses. One document
 * per point, unique on source, zone, granularity and period start.
 *
 * Connects on first use. A failed connection is not retried for the
 * lifetime of the store, so a run with MongoDB down fails fast on every
 * call and the resolver carries on without the store. Call close() at the
 * end of a run.
 */
export class MongoDbIntensityStore implements IntensityStore {
  private collectionPromise?: Promise<Collection<PointDocument>>

  constructor(
    private readonly client: MongoClient,
    private readonly databaseName: string = MONGODB_DATABASE,
  ) {}

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
    this.collectionPromise ??= (async () => {
      await this.client.connect()
      const collection = this.client
        .db(this.databaseName)
        .collection<PointDocument>(MONGODB_COLLECTION)
      await collection.createIndex(
        { sourceId: 1, zoneId: 1, granularity: 1, periodStart: 1 },
        { unique: true },
      )
      return collection
    })()
    return this.collectionPromise
  }
}
