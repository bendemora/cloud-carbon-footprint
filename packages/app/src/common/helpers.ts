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
} from '@cloud-carbon-footprint/common'
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
