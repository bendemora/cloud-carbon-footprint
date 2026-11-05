/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { Granularity, IntensityPoint, IntensityStore } from '../types'

const seriesId = (
  sourceId: string,
  zoneId: string,
  granularity: Granularity,
): string => `${sourceId}|${zoneId}|${granularity}`

/**
 * Keeps points for the lifetime of the process. Used in tests, as the store
 * for sources whose retention is 'session', and until the LOCAL and MONGODB
 * stores (section 6.6) are configured.
 */
export class InMemoryIntensityStore implements IntensityStore {
  private readonly series = new Map<string, Map<number, IntensityPoint>>()

  async get(
    sourceId: string,
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]> {
    const points = this.series.get(seriesId(sourceId, zoneId, granularity))
    if (!points) return []
    return [...points.values()]
      .filter((p) => p.periodStart < end && p.periodEnd > start)
      .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime())
  }

  async put(points: IntensityPoint[]): Promise<void> {
    for (const point of points) {
      const id = seriesId(point.sourceId, point.zoneId, point.granularity)
      let series = this.series.get(id)
      if (!series) {
        series = new Map()
        this.series.set(id, series)
      }
      series.set(point.periodStart.getTime(), point)
    }
  }

  /** Removes the source's points retrieved before `olderThan`. */
  async purge(sourceId: string, olderThan: Date): Promise<number> {
    let removed = 0
    for (const [id, series] of this.series) {
      if (!id.startsWith(`${sourceId}|`)) continue
      for (const [start, point] of series) {
        if (point.retrievedAt < olderThan) {
          series.delete(start)
          removed++
        }
      }
    }
    return removed
  }
}
