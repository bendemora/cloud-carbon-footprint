/*
 * © 2021 Thoughtworks, Inc.
 */

import { randomUUID } from 'crypto'
import fs, { promises } from 'fs'
import { resolve } from 'path'
import { Moment } from 'moment'
import { EstimationResult } from '@cloud-carbon-footprint/common'
import CacheManager, { CachedPeriod, DateRange } from './CacheManager'
import { EstimationRequest } from './CreateValidRequest'
import {
  cachedPeriodsOf,
  writeToFile,
  getCachedData,
  getCacheFileName,
  getMissingDates,
  mergeEstimates,
  readCachedData,
  replacePeriods,
} from './common/helpers'

export const testCachePath = 'mock-estimates.json'

/** The cache file of a grouping. Test mode has one file for every grouping. */
const cacheFileOf = (grouping: string): string =>
  process.env.TEST_MODE ? testCachePath : getCacheFileName(grouping)

/**
 * What writing the cache file in place needed, before it was written through
 * a temporary file: a file that exists and may be read and written.
 */
const READ_AND_WRITE = fs.constants.R_OK | fs.constants.W_OK

/**
 * A name for a temporary file next to the cache file. It is random because
 * process ids repeat across containers that share a volume. It ends in .json
 * so that the ignore patterns for cache files (the .gitignore of packages/api
 * and packages/cli) also cover a file that a stopped process leaves behind.
 */
const temporaryFileFor = (cacheFile: string): string =>
  `${cacheFile.replace(/\.json$/, '')}.${process.pid}-${randomUUID()}.tmp.json`

/** The mode a new file is opened with when none is given: the umask comes off it. */
const NEW_FILE_MODE = 0o666

/** The permission bits of a file's mode, without the bits for its type. */
const PERMISSIONS = 0o777

export default class LocalCacheManager extends CacheManager {
  cachedEstimates: EstimationResult[]
  fetchedEstimates: EstimationResult[]
  constructor() {
    super()
    this.cachedEstimates = []
    this.fetchedEstimates = []
  }

  async getEstimates(): Promise<EstimationResult[]> {
    return this.cachedEstimates.concat(this.fetchedEstimates)
  }

  async setEstimates(
    estimates: EstimationResult[],
    grouping: string,
  ): Promise<void> {
    this.fetchedEstimates = estimates
    const cacheFile = cacheFileOf(grouping)

    const mergedEstimates = mergeEstimates(estimates, this.cachedEstimates)
    try {
      // The cache file used to be written in place. As then, a cache file
      // that has gone, or that may not be written, is left alone.
      await promises.access(cacheFile, READ_AND_WRITE)
      const cachedData = await this.loadEstimates(grouping)
      await this.writeCacheFile(
        cacheFile,
        mergeEstimates(mergedEstimates, cachedData),
      )
    } catch (err) {
      console.warn(`Setting estimates error: ${err.message}`)
    }
  }

  async getMissingDates(
    request: EstimationRequest,
    grouping: string,
  ): Promise<Moment[]> {
    this.cacheLogger.info('Using local cache file...')

    const estimates = await this.loadEstimates(grouping)
    const filteredEstimates = this.filterEstimatesForRequest(request, estimates)

    this.cachedEstimates = filteredEstimates

    return getMissingDates(filteredEstimates, request, grouping)
  }

  async replaceEstimates(
    estimates: EstimationResult[],
    grouping: string,
    cloudProviders?: string[],
  ): Promise<void> {
    if (!estimates.length) return
    const cacheFile = cacheFileOf(grouping)
    const cachedData = await this.readCacheFile(cacheFile, READ_AND_WRITE)
    await this.writeCacheFile(
      cacheFile,
      replacePeriods(cachedData, estimates, cloudProviders),
    )
  }

  async getCachedPeriods(
    grouping: string,
    range?: DateRange,
  ): Promise<CachedPeriod[]> {
    return cachedPeriodsOf(
      await this.readCacheFile(cacheFileOf(grouping), fs.constants.R_OK),
      range,
    )
  }

  locationOf(grouping: string): string {
    return `file ${resolve(cacheFileOf(grouping))}`
  }

  /**
   * Writes the estimates as the cache file: to a temporary file in the same
   * directory first, which then takes the place of the cache file in one
   * rename. A write that fails part way leaves the cache file as it was, and
   * the temporary file is removed (ADR 0025). The new file gets the mode of
   * the file it replaces, as a file that is written in place keeps its mode.
   */
  private async writeCacheFile(
    cacheFile: string,
    estimates: EstimationResult[],
  ): Promise<void> {
    const { file, mode } = await this.fileToReplace(cacheFile)
    const temporaryFile = temporaryFileFor(file)
    const fh = await promises.open(temporaryFile, 'wx', mode ?? NEW_FILE_MODE)
    try {
      try {
        // Opening a file takes the umask off the mode, so a mode that is
        // wider than the umask allows is set here. A file system that has no
        // modes must not stop the write.
        if (mode !== undefined) await fh.chmod(mode).catch(() => undefined)
        await writeToFile(promises, estimates, fh)
      } finally {
        await fh.close()
      }
      await promises.rename(temporaryFile, file)
    } catch (error) {
      await promises.rm(temporaryFile, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /**
   * The file that a write of the cache file replaces, and its mode. It is the
   * cache file itself, or the file it leads to when it is a symbolic link:
   * renaming over the link would put a file in its place, where writing in
   * place wrote through it. Nothing is known of a cache file that is not
   * there yet.
   */
  private async fileToReplace(
    cacheFile: string,
  ): Promise<{ file: string; mode?: number }> {
    try {
      const found = await promises.lstat(cacheFile)
      if (!found.isSymbolicLink())
        return { file: cacheFile, mode: found.mode & PERMISSIONS }
      const file = await promises.realpath(cacheFile)
      return { file, mode: (await promises.stat(file)).mode & PERMISSIONS }
    } catch {
      return { file: cacheFile }
    }
  }

  /**
   * Reads the whole cache file for replaceEstimates and getCachedPeriods.
   * Unlike loadEstimates it creates no file, and it fails when the file
   * cannot be read or parsed instead of answering as if nothing were cached:
   * a replace that went on from there would write a cache without the
   * periods it could not read. A file that does not exist holds nothing. One
   * that exists must allow the given access, so that a cache file protected
   * from writing is not replaced.
   */
  private async readCacheFile(
    cacheFile: string,
    access: number,
  ): Promise<EstimationResult[]> {
    try {
      await promises.access(cacheFile, access)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    return readCachedData(fs.createReadStream(cacheFile))
  }

  private async loadEstimates(grouping: string): Promise<EstimationResult[]> {
    let cachedData: EstimationResult[] = []
    const loadedCache = cacheFileOf(grouping)
    try {
      await promises.access(loadedCache)
      const dataStream = await fs.createReadStream(loadedCache)
      cachedData = await getCachedData(dataStream)
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this.createCacheFile(loadedCache)
      } else {
        this.handleCacheReadError()
      }
    }
    return cachedData
  }

  private handleCacheReadError() {
    this.cacheLogger.warn(
      'There was an error parsing the cache file. Ignoring cache and fetching fresh estimates...',
    )
  }

  private async createCacheFile(filePath) {
    this.cacheLogger.warn('Cache file not found. Creating new cache file...')
    await promises.writeFile(filePath, '[]', 'utf8')
  }
}
