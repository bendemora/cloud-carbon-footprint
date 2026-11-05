/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto'
import { Dirent } from 'fs'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises'
import { dirname, join, resolve } from 'path'
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

/** `<YYYY-MM>.<granularity>.json`, or `<YYYY>.year.json`. */
const STORE_FILE = /^\d{4}(-\d{2})?\.(hour|day|month|year)\.json$/
/** What write() leaves when the process stops between write and rename. */
const TEMPORARY_FILE =
  /^(\d{4}(-\d{2})?\.(hour|day|month|year)\.json)\..+\.tmp$/

/**
 * The first id a store file disagrees on, or null. On a case-insensitive
 * file system (the macOS default) the paths of ids that differ only in case
 * are the same file, so the ids in the file are the ones that count.
 */
const mismatch = (
  file: StoreFile,
  sourceId: string,
  zoneId: string,
): string | null => {
  if (file.sourceId !== sourceId)
    return `source '${file.sourceId}', not '${sourceId}'`
  if (file.zoneId !== zoneId) return `zone '${file.zoneId}', not '${zoneId}'`
  return null
}

/*
 * Read-merge-write cycles on one file run one at a time within the process,
 * across every store on the same directory: GCP Recommendations resolves
 * rows concurrently, and the API serves overlapping requests. The queue
 * ignores case, because on a case-insensitive file system paths that
 * differ only in case are one file; on a case-sensitive one this only
 * serialises two files that did not need it.
 */
const fileQueues = new Map<string, Promise<void>>()

/** A temporary file younger than this may still be in another writer's hands. */
const TEMPORARY_FILE_MIN_AGE_MS = 60 * 60 * 1000

const exclusively = async <T>(
  path: string,
  task: () => Promise<T>,
): Promise<T> => {
  const queued = resolve(path).normalize('NFC').toLowerCase()
  const result = (fileQueues.get(queued) ?? Promise.resolve()).then(task)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  fileQueues.set(queued, settled)
  try {
    return await result
  } finally {
    if (fileQueues.get(queued) === settled) fileQueues.delete(queued)
  }
}

/**
 * The LOCAL store (design section 6.6): one JSON file per source, zone,
 * granularity and calendar month, at
 * `<directory>/<source>/<zone>/<YYYY-MM>.<granularity>.json`. No native
 * dependencies. Store files may hold licensed data and must not be
 * committed; `.ccf/` is in .gitignore.
 *
 * Writes to one file are serialised within a process. Writers in different
 * processes (a CLI run and the API on one directory) are not: each write is
 * a rename, so no file is ever half-written, but the later rename wins and
 * the other process's points for that month are fetched again when next
 * needed.
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
      if (!file || mismatch(file, sourceId, zoneId)) continue
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
      await exclusively(path, async () => {
        const existing = await this.read(path)
        const conflict = existing && mismatch(existing, sourceId, zoneId)
        if (conflict)
          throw new Error(
            `Grid intensity store file ${path} holds ${conflict}. On a case-insensitive file system, ids that differ only in case share a file, so these points are not stored.`,
          )
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
      })
    }
  }

  /**
   * Removes the source's points retrieved before `olderThan`, and temporary
   * files last changed before it and over an hour ago (left by a process
   * that stopped mid-write).
   * Files and directories the store did not write are skipped. A file that
   * cannot be read does not stop the purge of the others; the purge then
   * fails naming it.
   */
  async purge(sourceId: string, olderThan: Date): Promise<number> {
    const sourceDirectory = join(this.directory, segment(sourceId))
    let removed = 0
    const failures: string[] = []
    for (const zone of await this.list(sourceDirectory)) {
      if (!zone.isDirectory()) continue
      const zoneDirectory = join(sourceDirectory, zone.name)
      try {
        for (const entry of await this.list(zoneDirectory)) {
          if (!entry.isFile()) continue
          const path = join(zoneDirectory, entry.name)
          const temporary = TEMPORARY_FILE.exec(entry.name)
          try {
            if (STORE_FILE.test(entry.name))
              removed += await this.purgeFile(path, olderThan)
            else if (temporary)
              await this.removeIfOlder(
                path,
                join(zoneDirectory, temporary[1]),
                olderThan,
              )
          } catch (error) {
            failures.push((error as Error).message)
          }
        }
      } catch (error) {
        failures.push((error as Error).message)
      }
    }
    if (failures.length)
      throw new Error(
        `Grid intensity store purge for ${sourceId} could not purge ${failures.length} of the store's paths (points removed from the others: ${removed}): ${failures.join('; ')}`,
      )
    return removed
  }

  private purgeFile(path: string, olderThan: Date): Promise<number> {
    return exclusively(path, async () => {
      const file = await this.read(path)
      if (!file) return 0
      const kept = file.points.filter(
        (p) => new Date(p.retrievedAt) >= olderThan,
      )
      if (kept.length === file.points.length) return 0
      if (kept.length) await this.write(path, { ...file, points: kept })
      else await rm(path, { force: true })
      return file.points.length - kept.length
    })
  }

  /**
   * Under the lock of the file it was for, so no write in this process is
   * cut off, and only when last changed over an hour ago, so neither is
   * another process's. A file another process has renamed meanwhile is
   * skipped.
   */
  private removeIfOlder(
    temporary: string,
    target: string,
    olderThan: Date,
  ): Promise<void> {
    const cutOff = Math.min(
      olderThan.getTime(),
      Date.now() - TEMPORARY_FILE_MIN_AGE_MS,
    )
    return exclusively(target, async () => {
      const changed = await stat(temporary).then(
        (stats) => stats.mtime.getTime(),
        () => null,
      )
      if (changed !== null && changed < cutOff)
        await rm(temporary, { force: true })
    })
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

  /**
   * Writes to a temporary file with a random name, then renames it into
   * place, so a crash leaves no half-written store file. The name is random
   * because process ids repeat across containers sharing a volume.
   */
  private async write(path: string, file: StoreFile): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(file), { flag: 'wx' })
      await rename(temporary, path)
    } catch (error) {
      // EEXIST: the file is another writer's, not ours to remove.
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST')
        await rm(temporary, { force: true })
      throw error
    }
  }

  private async list(directory: string): Promise<Dirent[]> {
    try {
      return await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }
}
