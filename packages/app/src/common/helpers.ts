/**
 * © 2021 Thoughtworks, Inc.
 */

import moment, { Moment } from 'moment'
import { Stream } from 'stream'
import { FileHandle } from 'fs/promises'
import { DelimitedStream } from '@sovpro/delimited-stream'
import {
  EstimationResult,
  getPeriodEndDate,
  GroupBy,
  QualityTier,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import { CachedPeriod, DateRange, WorstTier } from '../CacheManager'
import { EstimationRequest } from '../CreateValidRequest'
import R from 'ramda'

/**
 * Characters of serialised estimation results to gather before each write.
 * Sizing windows by length rather than by a count of results keeps every
 * string well below the longest string Node can hold (about 512 MiB), however
 * many rows each period has.
 */
export const CACHE_WRITE_WINDOW_CHARS = 16 * 1024 * 1024

/**
 * Writes the estimates as a cache file: a JSON array with one estimation
 * result per line, the format getCachedData reads. Results are written in
 * windows of at least windowChars characters (the last may be shorter); a
 * result longer than that is written in a window of its own. One result must
 * still fit in one string, as getCachedData reads it back as one line.
 */
export const writeToFile = async (
  writeStream: any,
  mergedData: EstimationResult[],
  fh?: FileHandle,
  windowChars = CACHE_WRITE_WINDOW_CHARS,
) => {
  const OPEN_BRACKET = '[' + '\n'
  const CLOSE_BRACKET = '\n' + ']'
  const COMMA_SEPARATOR = '\n' + ',' + '\n'

  async function writeIt(output: string) {
    if (fh) {
      await writeStream.writeFile(fh, output)
    } else {
      await writeStream.write(output)
    }
  }

  await writeIt(OPEN_BRACKET) // beginning of the cache file
  let window = ''
  for (let i = 0; i < mergedData.length; i++) {
    window += (window ? COMMA_SEPARATOR : '') + JSON.stringify(mergedData[i])
    const isLast = i === mergedData.length - 1
    if (window.length >= windowChars || isLast) {
      await writeIt(window)
      window = ''
      if (!isLast) await writeIt(COMMA_SEPARATOR)
    }
  }
  await writeIt(CLOSE_BRACKET) // end of the cache file
}

export const getCachedData = async (
  dataStream: Stream,
): Promise<EstimationResult[]> => {
  const delimitedStream = await new DelimitedStream(Buffer.from('\n'))
  return await new Promise((resolve, reject) => {
    const arr: EstimationResult[] = []
    delimitedStream.on('data', (data) => {
      try {
        const line = data.toString()
        if (isNotADataDelimiter(line)) {
          arr.push(JSON.parse(line, dateTimeReviver))
        }
      } catch (err) {
        reject(err)
      }
    })
    delimitedStream.on('error', (err) => reject(err))
    delimitedStream.on('end', () => {
      resolve(arr)
    })
    dataStream.pipe(delimitedStream)
  })
}

/**
 * Reads a cache file for the operations that must know all of it: replacing
 * cached rows and listing the cached periods (ADR 0025). It reads as
 * getCachedData does, with three differences.
 *
 * - It fails when the stream it reads from fails. getCachedData does not
 *   notice that: its result then never settles.
 * - It leaves out the empty array that an empty cache reads as. A cache file
 *   is created holding "[]" on one line, which getCachedData reads as one
 *   entry, and the first write to a local cache file carries that entry
 *   along as a line of its own.
 * - It fails when any other entry is not an estimation result, so that a
 *   cache it does not understand is not written again.
 */
export const readCachedData = async (
  dataStream: Stream,
): Promise<EstimationResult[]> => {
  const entries: unknown[] = await new Promise((resolve, reject) => {
    dataStream.once('error', reject)
    getCachedData(dataStream).then(resolve, reject)
  })
  const results = entries.filter(
    (entry) => !(Array.isArray(entry) && entry.length === 0),
  )
  const unknown = results.find((entry) => !isEstimationResult(entry))
  if (unknown !== undefined)
    throw new Error(
      `The estimates cache holds an entry that is not an estimation result: ${JSON.stringify(unknown).slice(0, 80)}`,
    )
  return results as EstimationResult[]
}

const isEstimationResult = (entry: any): boolean =>
  entry?.timestamp instanceof Date &&
  !Number.isNaN(entry.timestamp.getTime()) &&
  Array.isArray(entry.serviceEstimates)

const isNotADataDelimiter = (l: string) => {
  // data delimiters are [, ], or empty line
  // and are encoded on writeToFile() function
  return !/^[[\],\n]$/.test(l)
}

const dateTimeReviver = (key: string, value: string) => {
  if (key === 'timestamp') return moment.utc(value).toDate()
  return value
}

/**
 * Returns the file name of the estimates cache.
 *
 * @param grouping Unit of measure that the data will be grouped by
 */
export function getCacheFileName(grouping: string): string {
  const cachePrefix = process.env.CCF_CACHE_PATH || 'estimates.cache'
  const existingFileExtension = cachePrefix.lastIndexOf('.json')
  const prefix =
    existingFileExtension !== -1
      ? cachePrefix.substr(0, existingFileExtension)
      : cachePrefix
  return `${prefix}.${grouping}.json`
}

/**
 * Grabs the estimates that should persist in the cache by removing empty estimates according to the provided missing dates
 * @param missingDates - An array of dates that are missing from the cache
 * @param estimates    - An array of estimates that are not in the cache
 * @param grouping     - The unit of time that the data is grouped by
 * @returns EstimationResult[] - An array of estimates that should be persisted in the cache
 */
export const fillDates = (
  missingDates: Moment[],
  estimates: EstimationResult[],
  grouping: GroupBy,
): EstimationResult[] => {
  const dates: Date[] = estimates.map(({ timestamp }) => {
    return timestamp
  })

  // converts missing dates to Date object to compare to estimate dates
  const missingDatesConverted: Date[] = missingDates.map((timestamp) => {
    return timestamp.toDate()
  })

  const difference = R.difference(missingDatesConverted, dates)
  const emptyEstimates = difference.map((timestamp) => {
    return {
      timestamp: timestamp,
      serviceEstimates: [],
      periodStartDate: timestamp,
      periodEndDate: getPeriodEndDate(timestamp, grouping),
      groupBy: grouping,
    }
  })
  return [...emptyEstimates, ...estimates].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  )
}

export const concat = (
  cachedEstimates: EstimationResult[],
  estimates: EstimationResult[],
) => {
  return [...cachedEstimates, ...estimates].sort((a, b) => {
    return a.timestamp.getTime() - b.timestamp.getTime()
  })
}

export const getDatesWithinRequestTimeFrame = (
  grouping: string,
  request: EstimationRequest,
): Moment[] => {
  const dates: Moment[] = []
  const unitOfTime =
    grouping === 'week' ? 'isoWeek' : (grouping as moment.unitOfTime.StartOf)
  const current = moment.utc(request.startDate).startOf(unitOfTime)
  const end = moment.utc(request.endDate)
  while (current <= end) {
    dates.push(current.clone())
    current.add(1, grouping as moment.unitOfTime.DurationConstructor)
  }
  return dates
}

/**
 * Returns a list of missing dates within the request according to the provided cached estimates
 * @param cachedEstimates - An array of cached estimates
 * @param request         - The original EstimationRequest
 * @returns Moment[]      - An array of missing dates
 */
export const getMissingDates = (
  cachedEstimates: EstimationResult[],
  request: EstimationRequest,
  grouping: string,
): Moment[] => {
  const cachedDates: Moment[] = cachedEstimates.map(({ timestamp }) => {
    return moment.utc(timestamp)
  })
  cachedDates.sort((a, b) => {
    return a.valueOf() - b.valueOf()
  })

  const missingDates: Moment[] = []
  const dates = getDatesWithinRequestTimeFrame(grouping, request)

  dates.forEach((date) => {
    const dateIsCached = !!cachedDates.find((cachedDate) => {
      return cachedDate.isSame(date)
    })

    if (!dateIsCached) missingDates.push(date)
  })
  return missingDates
}

// Filter out empty estimates
export const filterCachedEstimates = (
  cachedEstimates: EstimationResult[],
): EstimationResult[] => {
  return cachedEstimates.filter(({ serviceEstimates }) => {
    return serviceEstimates.length !== 0
  })
}

export const includeCloudProviders = (
  cloudProviderToSeed: string,
  config: any,
) => {
  const supportedCloudProviders = ['AWS', 'GCP', 'AZURE']
  if (cloudProviderToSeed) {
    supportedCloudProviders.forEach((cloudProvider: string) => {
      if (cloudProvider === cloudProviderToSeed.toUpperCase()) {
        config[cloudProvider].INCLUDE_ESTIMATES = true
      } else {
        config[cloudProvider].INCLUDE_ESTIMATES = false
      }
    })
  }
}

/**
 * Merges two already-sorted arrays of estimates into one array of estimates sorted by timestamp.
 * @param estimatesOne - An array of estimates sorted by timestamp (takes priority when comparing same dates)
 * @param estimatesTwo - An array of estimates sorted by timestamp
 */
export const mergeEstimates = (
  estimatesOne: EstimationResult[],
  estimatesTwo: EstimationResult[],
): EstimationResult[] => {
  const mergedData = []
  let i = 0,
    j = 0

  while (i < estimatesOne.length && j < estimatesTwo.length) {
    const dateOne = moment.utc(estimatesOne[i].timestamp)
    const dateTwo = moment.utc(estimatesTwo[j].timestamp)

    if (dateOne.isBefore(dateTwo)) {
      mergedData.push(estimatesOne[i])
      i++
    } else if (dateTwo.isBefore(dateOne)) {
      mergedData.push(estimatesTwo[j])
      j++
    } else {
      // Prefer new estimates over existing estimates
      // if comparing fetched vs cached, estimatesOne should be the fetched estimates
      mergedData.push(estimatesOne[i])
      i++
      j++
    }
  }
  // Append remaining entries from either array
  while (i < estimatesOne.length) mergedData.push(estimatesOne[i++])
  while (j < estimatesTwo.length) mergedData.push(estimatesTwo[j++])

  return mergedData
}

const timeOf = ({ timestamp }: { timestamp: Date }): number =>
  new Date(timestamp).getTime()

/**
 * The cached estimates with the periods of the new estimates replaced
 * (ADR 0025), ordered by timestamp. It is what the cache file holds after
 * CacheManager.replaceEstimates.
 *
 * For each period of the new estimates, the cached rows of the given cloud
 * providers go and the new rows take their place. Providers are compared
 * without regard to case. With no cloudProviders every cached row of the
 * period goes. A period that is not cached is added. Cached periods that are
 * not among the new estimates stay as they are. Unlike mergeEstimates it does
 * not need either list to be in order, and it leaves one result for each
 * period it replaces, also when the cache held that period more than once.
 * A cached entry without a timestamp is not a period and is left out: an
 * empty cache file reads as one (see readCachedData).
 */
export const replacePeriods = (
  cachedEstimates: EstimationResult[],
  newEstimates: EstimationResult[],
  cloudProviders?: string[],
): EstimationResult[] => {
  const providers =
    cloudProviders &&
    new Set(cloudProviders.map((provider) => provider.toUpperCase()))

  // New results that share a timestamp are the rows of one period.
  const replacements = new Map<number, EstimationResult>()
  for (const estimate of newEstimates) {
    const sameTime = replacements.get(timeOf(estimate))
    replacements.set(
      timeOf(estimate),
      sameTime
        ? {
            ...sameTime,
            serviceEstimates: sameTime.serviceEstimates.concat(
              estimate.serviceEstimates,
            ),
          }
        : estimate,
    )
  }

  const untouched: EstimationResult[] = []
  const keptRows = new Map<number, ServiceData[]>()
  for (const cached of cachedEstimates) {
    const time = timeOf(cached)
    if (Number.isNaN(time)) continue
    if (!replacements.has(time)) untouched.push(cached)
    else if (providers)
      keptRows.set(
        time,
        (keptRows.get(time) ?? []).concat(
          cached.serviceEstimates.filter(
            (row) => !providers.has(row.cloudProvider.toUpperCase()),
          ),
        ),
      )
  }

  const replaced = [...replacements].map(([time, estimate]) => ({
    ...estimate,
    serviceEstimates: (keptRows.get(time) ?? []).concat(
      estimate.serviceEstimates,
    ),
  }))
  return [...untouched, ...replaced].sort((a, b) => timeOf(a) - timeOf(b))
}

/** The quality tiers, best first (design section 6.4). */
export const QUALITY_TIERS: QualityTier[] = ['A', 'B', 'C', 'D']

/** Whether the first tier is worse than the second. D is the worst. */
export const isWorseTier = (tier: QualityTier, than: QualityTier): boolean =>
  QUALITY_TIERS.indexOf(tier) > QUALITY_TIERS.indexOf(than)

/** One id for a region of a cloud provider, whatever the provider's case. */
export const regionIdOf = (cloudProvider: string, region: string): string =>
  `${cloudProvider.toUpperCase()}\u0000${region}`

/**
 * Adds rows to the worst tiers found so far, which are held by regionIdOf.
 * A row counts when it has provenance with one of the four tiers.
 */
const noteWorstTiers = (
  worstTiers: Map<string, WorstTier>,
  rows: ServiceData[],
): void => {
  for (const { cloudProvider, region, provenance } of rows) {
    const qualityTier = provenance?.qualityTier
    if (!QUALITY_TIERS.includes(qualityTier)) continue
    const regionId = regionIdOf(cloudProvider, region)
    const worst = worstTiers.get(regionId)
    if (!worst || isWorseTier(qualityTier, worst.qualityTier))
      worstTiers.set(regionId, { cloudProvider, region, qualityTier })
  }
}

/**
 * The worst quality tier among the rows that carry provenance, for each
 * cloud provider and region that has such rows. Providers are told apart
 * without regard to case.
 */
export const worstTiersOf = (rows: ServiceData[]): WorstTier[] => {
  const worstTiers = new Map<string, WorstTier>()
  noteWorstTiers(worstTiers, rows)
  return [...worstTiers.values()]
}

/**
 * The periods of cached estimates, oldest first: whether each holds
 * provisional rows, and the worst quality tier of its rows by cloud provider
 * and region (CacheManager.getCachedPeriods). With a range, only the periods
 * whose timestamp lies in it, both ends included. Results that share a
 * timestamp count as one period.
 */
export const cachedPeriodsOf = (
  cachedEstimates: EstimationResult[],
  range?: DateRange,
): CachedPeriod[] => {
  const periods = new Map<
    number,
    { isProvisional: boolean; worstTiers: Map<string, WorstTier> }
  >()
  for (const estimate of cachedEstimates) {
    const time = timeOf(estimate)
    const isInRange =
      !range ||
      (time >= range.startDate.getTime() && time <= range.endDate.getTime())
    if (!isInRange) continue
    const period = periods.get(time) ?? {
      isProvisional: false,
      worstTiers: new Map<string, WorstTier>(),
    }
    period.isProvisional ||= estimate.serviceEstimates.some(
      (row) => row.provenance?.isProvisional === true,
    )
    noteWorstTiers(period.worstTiers, estimate.serviceEstimates)
    periods.set(time, period)
  }
  return [...periods]
    .sort(([timeOne], [timeTwo]) => timeOne - timeTwo)
    .map(([time, { isProvisional, worstTiers }]) => ({
      timestamp: new Date(time),
      isProvisional,
      worstTiers: [...worstTiers.values()],
    }))
}
