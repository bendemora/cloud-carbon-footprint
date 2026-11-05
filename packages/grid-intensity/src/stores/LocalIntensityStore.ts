/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { periodsCovering, startOfPeriod } from '../granularity'
import {
  EmissionFactorType,
  Granularity,
  IntensityBasis,
  IntensityPoint,
  IntensityStore,
} from '../types'

export const DEFAULT_STORE_PATH = '.ccf/grid-intensity'
const FORMAT_VERSION = 1

interface StoredPoint {
  periodStart: string
  periodEnd: string
  gCO2ePerKWh: number
  basis: IntensityBasis
  factorType: EmissionFactorType
  isEstimated: boolean
  retrievedAt: string
}

interface StoreFile {
  version: number
  sourceId: string
  zoneId: string
  granularity: Granularity
  points: StoredPoint[]
}

/** Safe as one path segment: also encodes '.', so '..' cannot climb out. */
const segment = (value: string): string =>
  encodeURIComponent(value).replace(/\./g, '%2E')

/**
 * Points are bucketed by the calendar month of their start (by year for
 * annual points). Hourly, daily and monthly points never cross a month
 * boundary, so a point is always in exactly one bucket.
 */
const bucketGranularity = (granularity: Granularity): Granularity =>
  granularity === 'year' ? 'year' : 'month'

const bucketLabel = (date: Date, granularity: Granularity): string => {
  const year = String(date.getUTCFullYear())
  return bucketGranularity(granularity) === 'year'
    ? year
    : `${year}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

const toStored = (p: IntensityPoint): StoredPoint => ({
  periodStart: p.periodStart.toISOString(),
  periodEnd: p.periodEnd.toISOString(),
  gCO2ePerKWh: p.gCO2ePerKWh,
  basis: p.basis,
  factorType: p.factorType,
  isEstimated: p.isEstimated,
  retrievedAt: p.retrievedAt.toISOString(),
})

const fromStored = (file: StoreFile, p: StoredPoint): IntensityPoint => ({
  zoneId: file.zoneId,
  periodStart: new Date(p.periodStart),
  periodEnd: new Date(p.periodEnd),
  granularity: file.granularity,
  gCO2ePerKWh: p.gCO2ePerKWh,
  basis: p.basis,
  factorType: p.factorType,
  isEstimated: p.isEstimated,
  sourceId: file.sourceId,
  retrievedAt: new Date(p.retrievedAt),
})

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/**
 * The LOCAL store (design section 6.6): one JSON file per source, zone,
 * granularity and calendar month, at
 * `<directory>/<source>/<zone>/<YYYY-MM>.<granularity>.json`. No native
 * dependencies. Store files may hold licensed data and must not be
 * committed; `.ccf/` is in .gitignore.
 */
export class LocalIntensityStore implements IntensityStore {
  constructor(private readonly directory: string = DEFAULT_STORE_PATH) {}

  async get(
    sourceId: string,
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]> {
    const buckets = periodsCovering(
      startOfPeriod(start, granularity),
      end,
      bucketGranularity(granularity),
    )
    const points: IntensityPoint[] = []
    for (const bucket of buckets) {
      const file = await this.read(
        this.filePath(
          sourceId,
          zoneId,
          bucketLabel(bucket.start, granularity),
          granularity,
        ),
      )
      if (!file) continue
      for (const stored of file.points) {
        const point = fromStored(file, stored)
        if (point.periodStart < end && point.periodEnd > start)
          points.push(point)
      }
    }
    return points.sort(
      (a, b) => a.periodStart.getTime() - b.periodStart.getTime(),
    )
  }

  async put(points: IntensityPoint[]): Promise<void> {
    const byFile = new Map<string, IntensityPoint[]>()
    for (const point of points) {
      const path = this.filePath(
        point.sourceId,
        point.zoneId,
        bucketLabel(point.periodStart, point.granularity),
        point.granularity,
      )
      byFile.set(path, [...(byFile.get(path) ?? []), point])
    }
    for (const [path, filePoints] of byFile) {
      const { sourceId, zoneId, granularity } = filePoints[0]
      const existing = await this.read(path)
      const merged = new Map<string, StoredPoint>()
      for (const stored of existing?.points ?? [])
        merged.set(stored.periodStart, stored)
      for (const point of filePoints)
        merged.set(point.periodStart.toISOString(), toStored(point))
      await this.write(path, {
        version: FORMAT_VERSION,
        sourceId,
        zoneId,
        granularity,
        points: [...merged.values()].sort((a, b) =>
          a.periodStart.localeCompare(b.periodStart),
        ),
      })
    }
  }

  /** Removes the source's points retrieved before `olderThan`. */
  async purge(sourceId: string, olderThan: Date): Promise<number> {
    const sourceDirectory = join(this.directory, segment(sourceId))
    let removed = 0
    for (const zone of await this.list(sourceDirectory)) {
      const zoneDirectory = join(sourceDirectory, zone)
      for (const name of await this.list(zoneDirectory)) {
        const path = join(zoneDirectory, name)
        const file = await this.read(path)
        if (!file) continue
        const kept = file.points.filter(
          (p) => new Date(p.retrievedAt) >= olderThan,
        )
        if (kept.length === file.points.length) continue
        removed += file.points.length - kept.length
        if (kept.length) await this.write(path, { ...file, points: kept })
        else await rm(path)
      }
    }
    return removed
  }

  private filePath(
    sourceId: string,
    zoneId: string,
    bucket: string,
    granularity: Granularity,
  ): string {
    return join(
      this.directory,
      segment(sourceId),
      segment(zoneId),
      `${bucket}.${granularity}.json`,
    )
  }

  private async read(path: string): Promise<StoreFile | null> {
    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    try {
      const file = JSON.parse(content) as StoreFile
      if (file.version !== FORMAT_VERSION || !Array.isArray(file.points))
        throw new Error(`unsupported format version ${file.version}`)
      return file
    } catch (error) {
      throw new Error(
        `Corrupt grid intensity store file ${path}: ${(error as Error).message}. Delete it to rebuild.`,
      )
    }
  }

  /** Writes to a temporary file and renames it, so a crash leaves no half-written file. */
  private async write(path: string, file: StoreFile): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(file))
    await rename(temporary, path)
  }

  private async list(directory: string): Promise<string[]> {
    try {
      return await readdir(directory)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }
}
