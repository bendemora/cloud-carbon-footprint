/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { Granularity, IntensityPoint, IntensityStore } from '../types'

/** How long a read is remembered. */
export const RECENT_READ_MS = 60 * 1000

/** The most usage periods remembered for one series at one time. */
export const MAX_READS_PER_SERIES = 1000

interface Read {
  points: Promise<IntensityPoint[]>
  until: number
}

const seriesId = (
  sourceId: string,
  zoneId: string,
  granularity: Granularity,
): string => `${sourceId}|${zoneId}|${granularity}`

/**
 * A store in front of another that remembers, for a minute, what was read
 * from it for each series and usage period.
 *
 * The resolver is called once for every billing row, and the rows of one
 * region and period are many. Without this each of them reads the store
 * again: the LOCAL store reads and parses a month's file each time, and
 * the MongoDB store sends a query.
 *
 * What this process writes through it is seen at once: a write or a purge
 * forgets what was read of the series it touches. What another process
 * writes to the same store is seen a minute late at most. The cost of that
 * is a request to a source for points the other process had just stored,
 * never a wrong value: the resolver fetches what it does not see, and the
 * stores merge what they are given.
 *
 * The points of a remembered read are the same objects each time. Callers
 * do not change the points they are given.
 */
export class RecentReadsStore implements IntensityStore {
  /** By series, then by the start and end of the usage period. */
  private readonly reads = new Map<string, Map<string, Read>>()

  constructor(
    private readonly store: IntensityStore & { close?: () => Promise<void> },
    private readonly now: () => number = Date.now,
  ) {}

  async get(
    sourceId: string,
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]> {
    const series = seriesId(sourceId, zoneId, granularity)
    const period = `${start.getTime()}|${end.getTime()}`
    const nowMs = this.now()
    let reads = this.reads.get(series)
    const recent = reads?.get(period)
    if (recent && recent.until > nowMs) return [...(await recent.points)]
    // The reads of a series are in the order they were made, so the ones
    // that have run out are at the front.
    for (const [earlier, { until }] of reads ?? []) {
      if (until > nowMs) break
      reads?.delete(earlier)
    }
    if (!reads || reads.size >= MAX_READS_PER_SERIES) {
      reads = new Map()
      this.reads.set(series, reads)
    }
    // Remembered from the moment it starts, so that calls made at the same
    // time share one read, and a write that comes while it is under way
    // leaves it behind with the series it belongs to.
    const read: Read = {
      points: this.store.get(sourceId, zoneId, start, end, granularity),
      until: nowMs + RECENT_READ_MS,
    }
    reads.set(period, read)
    try {
      return [...(await read.points)]
    } catch (error) {
      if (reads.get(period) === read) reads.delete(period)
      throw error
    }
  }

  async put(points: IntensityPoint[]): Promise<void> {
    try {
      await this.store.put(points)
    } finally {
      for (const point of points)
        this.reads.delete(
          seriesId(point.sourceId, point.zoneId, point.granularity),
        )
    }
  }

  async purge(sourceId: string, olderThan: Date): Promise<number> {
    try {
      return await this.store.purge(sourceId, olderThan)
    } finally {
      for (const series of this.reads.keys())
        if (series.startsWith(`${sourceId}|`)) this.reads.delete(series)
    }
  }

  /** Closes the store behind this one, when it can be closed. */
  async close(): Promise<void> {
    await this.store.close?.()
  }
}
