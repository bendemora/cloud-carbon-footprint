/*
 * © 2021 Thoughtworks, Inc.
 */

import { File, Storage } from '@google-cloud/storage'
import { Moment } from 'moment'
import CacheManager, { CachedPeriod, DateRange } from './CacheManager'
import { configLoader, EstimationResult } from '@cloud-carbon-footprint/common'
import { EstimationRequest } from './CreateValidRequest'
import {
  cachedPeriodsOf,
  writeToFile,
  getCachedData,
  getCacheFileName,
  getMissingDates,
  readCachedData,
  replacePeriods,
} from './common/helpers'

const storage = new Storage()

/** The cache object of a grouping in the configured bucket. */
const cacheObjectOf = (grouping: string): File =>
  storage
    .bucket(configLoader().GCP.CACHE_BUCKET_NAME)
    .file(getCacheFileName(grouping))

/** The date of a result as a number, so that two dates can be compared. */
const timeOf = ({ timestamp }: EstimationResult): number =>
  new Date(timestamp).getTime()

export default class GoogleCloudCacheManager extends CacheManager {
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
    const bucketName = configLoader().GCP.CACHE_BUCKET_NAME
    // The cached results, then the new ones, as before. A date that is among
    // both is written once, with the new result: appending without looking
    // for the date wrote it twice (ADR 0025).
    const newDates = new Set(estimates.map(timeOf))
    const mergedData = this.cachedEstimates
      .filter((cached) => !newDates.has(timeOf(cached)))
      .concat(estimates)
    const cacheFileName = getCacheFileName(grouping)

    try {
      const cacheFile = storage.bucket(bucketName).file(cacheFileName)
      const writeStream = await cacheFile.createWriteStream()
      await writeToFile(writeStream, mergedData)
      writeStream.on('error', (err) => {
        console.error(`There was an error writing the file => ${err}`)
      })
      await writeStream.end()
    } catch (err) {
      console.warn(`Setting estimates error: ${err.message}`)
    }
  }

  async getMissingDates(
    request: EstimationRequest,
    grouping: string,
  ): Promise<Moment[]> {
    this.cacheLogger.info('Using GCS bucket cache file...')

    const estimates = await this.getCloudFileContent(grouping)
    const filteredEstimates = estimates
      ? this.filterEstimatesForRequest(request, estimates)
      : []

    this.cachedEstimates = filteredEstimates

    return getMissingDates(filteredEstimates, request, grouping)
  }

  async replaceEstimates(
    estimates: EstimationResult[],
    grouping: string,
    cloudProviders?: string[],
  ): Promise<void> {
    if (!estimates.length) return
    const cacheFile = cacheObjectOf(grouping)
    const cachedData = await this.readCacheObject(cacheFile)
    await this.writeCacheObject(
      cacheFile,
      replacePeriods(cachedData, estimates, cloudProviders),
    )
  }

  async getCachedPeriods(
    grouping: string,
    range?: DateRange,
  ): Promise<CachedPeriod[]> {
    return cachedPeriodsOf(
      await this.readCacheObject(cacheObjectOf(grouping)),
      range,
    )
  }

  locationOf(grouping: string): string {
    return `gs://${configLoader().GCP.CACHE_BUCKET_NAME}/${getCacheFileName(grouping)}`
  }

  /**
   * Reads the whole cache object for replaceEstimates and getCachedPeriods.
   * Unlike getCloudFileContent it creates no object, and it fails when the
   * object cannot be read or parsed instead of answering as if nothing were
   * cached: a replace that went on from there would write a cache without
   * the periods it could not read. An object that does not exist holds
   * nothing.
   */
  private async readCacheObject(cacheFile: File): Promise<EstimationResult[]> {
    const [exists] = await cacheFile.exists()
    if (!exists) return []
    return readCachedData(await cacheFile.createReadStream())
  }

  /**
   * Writes the estimates as the cache object and waits for the upload to
   * end, so that a failed upload fails the call. Cloud Storage puts an
   * uploaded object in place of the old one only when the upload is
   * complete, so a write that fails part way leaves the cached object as it
   * was. That is what Cloud Storage documents; it was not tried against a
   * real bucket.
   */
  private async writeCacheObject(
    cacheFile: File,
    estimates: EstimationResult[],
  ): Promise<void> {
    const writeStream = await cacheFile.createWriteStream()
    await new Promise<void>((resolve, reject) => {
      writeStream.on('error', reject)
      writeStream.on('finish', () => resolve())
      writeToFile(writeStream, estimates).then(
        () => writeStream.end(),
        (error) => {
          // Give the upload up: nothing must be put in place of the object.
          writeStream.destroy()
          reject(error)
        },
      )
    })
  }

  private async getCloudFileContent(
    grouping: string,
  ): Promise<EstimationResult[]> {
    const cacheFileName = getCacheFileName(grouping)
    const bucketName = configLoader().GCP.CACHE_BUCKET_NAME
    let cachedData: EstimationResult[] | any = []
    try {
      const cacheFile = storage.bucket(bucketName).file(cacheFileName)
      const cacheFileExists = await Promise.resolve(
        storage.bucket(bucketName).file(cacheFileName).exists(),
      )

      if (cacheFileExists[0]) {
        const dataStream = await cacheFile.createReadStream()
        cachedData = await getCachedData(dataStream)
      } else {
        console.warn(
          'WARN: Unable to read cache file.',
          '\n',
          'Creating new cache file...',
        )
        await cacheFile.save('[]', {
          contentType: 'application/json',
        })
      }
    } catch (err) {
      if (err.code !== 404) {
        console.warn(`Error loading cloud data: ${err.message}`)
      }
      return []
    }
    return cachedData
  }
}
