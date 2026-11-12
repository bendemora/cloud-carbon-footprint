/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import commander from 'commander'
import process from 'process'

import {
  App,
  createValidFootprintRequest,
  MongoDbCacheManager,
  RefreshSummary,
} from '@cloud-carbon-footprint/app'
import { configLoader, GroupBy } from '@cloud-carbon-footprint/common'
import { shutdownDefaultResolver } from '@cloud-carbon-footprint/grid-intensity'

export interface RefreshOutcome {
  /** The summary of the refresh, in plain lines. */
  output: string
  /** 1 when a run failed, so that a scheduled job notices. 0 otherwise. */
  exitCode: number
}

/**
 * The refresh-estimates command (ADR 0025): estimates the cached periods of
 * a date range again and replaces them in the estimates cache. By default
 * only the periods that hold provisional rows, and with --all every cached
 * period in the range. It reads billing data for the periods it refreshes,
 * so it needs the cloud credentials that estimates need.
 */
export default async function refreshEstimates(
  argv: string[] = process.argv,
): Promise<RefreshOutcome> {
  const program = new commander.Command('refresh-estimates')
  program.storeOptionsAsProperties(false)

  program
    .option('-s, --startDate <string>', 'Start date in ISO format (required)')
    .option('-e, --endDate <string>', 'End date in ISO format (required)')
    .option(
      '-g, --groupBy <string>',
      'The grouping of the cached estimates to refresh: day, week, month, quarter or year',
      'day',
    )
    .option(
      '-a, --all',
      'Refresh every cached period in the range, not only the provisional ones',
    )
    .option(
      '--cloudProviderToSeed <string>',
      'Estimate one cloud provider only: aws, gcp or azure',
    )

  program.parse(argv)
  const options = program.opts()

  // The dates and the grouping are checked as the other commands check them.
  const { startDate, endDate, groupBy, cloudProviderToSeed } =
    createValidFootprintRequest({
      startDate: options.startDate,
      endDate: options.endDate,
      groupBy: options.groupBy,
      cloudProviderToSeed: options.cloudProviderToSeed,
    })
  const includeFinal = !!options.all

  const usesMongoDb = configLoader().CACHE_MODE === 'MONGODB'
  if (usesMongoDb) {
    await MongoDbCacheManager.createDbConnection()
  }

  let summary: RefreshSummary
  try {
    summary = await new App().refreshEstimates({
      startDate,
      endDate,
      groupBy: groupBy as GroupBy,
      includeFinal,
      cloudProviderToSeed,
    })
  } finally {
    // What the estimate commands close at the end of a run.
    await shutdownDefaultResolver()
    if (usesMongoDb) {
      await MongoDbCacheManager.mongoClient?.close()
    }
  }

  return {
    output: formatRefreshSummary(summary, { startDate, endDate, includeFinal }),
    exitCode: summary.failedRuns.length ? 1 : 0,
  }
}

const periods = (count: number): string =>
  `${count} ${count === 1 ? 'period' : 'periods'}`

export const formatRefreshSummary = (
  summary: RefreshSummary,
  request: { startDate: Date; endDate: Date; includeFinal: boolean },
): string => {
  const lines = [
    `Refresh of the cached estimates grouped by ${summary.groupBy}`,
    `Cache: ${summary.cache}`,
    `Range: periods that start from ${request.startDate.toISOString()} to ${request.endDate.toISOString()}`,
    `Refreshing: ${request.includeFinal ? 'every cached period in the range (--all)' : 'the cached periods in the range that hold provisional rows'}`,
    `Cached periods in the range: ${summary.cachedPeriods}`,
    `Provisional before: ${summary.provisionalBefore}`,
    `Estimation requests, one for each run of adjacent periods: ${summary.runs}`,
    `Periods refreshed: ${summary.refreshedPeriods}`,
    `Periods left alone because the new estimate had no rows: ${summary.emptyPeriods}`,
    `Periods kept because the new estimate had a worse quality tier: ${summary.keptBecauseWorse}`,
    `Provisional after: ${summary.provisionalAfter}`,
    `Failed runs: ${summary.failedRuns.length}`,
    ...summary.failedRuns.map(
      (run) =>
        `  ${run.startDate.toISOString()} to ${run.endDate.toISOString()}, ${periods(run.periods)} not refreshed: ${run.error}`,
    ),
  ]
  if (summary.keptBecauseWorse)
    lines.push(
      'Kept periods: a grid intensity source may have been out of reach during the run, so that the new estimate fell back to a worse source. The cached rows of the cloud provider concerned were kept. Run the refresh again later.',
    )
  if (!summary.cachedPeriods)
    lines.push(
      'Nothing to refresh: the cache holds no period of this grouping in the range.',
    )
  else if (!summary.runs)
    lines.push(
      'Nothing to refresh: no cached period in the range is provisional. Use --all to refresh every cached period.',
    )
  return lines.join('\n')
}
