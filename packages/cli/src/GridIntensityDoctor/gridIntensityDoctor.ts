/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  CachedPeriodCount,
  MongoDbCacheManager,
} from '@cloud-carbon-footprint/app'
import { configLoader } from '@cloud-carbon-footprint/common'
import {
  CapabilityReport,
  shutdownDefaultResolver,
  SourceCapabilitySummary,
} from '@cloud-carbon-footprint/grid-intensity'

/**
 * The grid intensity doctor (design section 6.5): the grid zone of every
 * provider region and what each configured source can deliver for it, as a
 * table. It needs no cloud credentials.
 *
 * After the table it says how many periods the estimates cache holds for
 * each grouping, and how many of them are provisional (ADR 0025). It says
 * nothing when nothing is cached.
 */
export default async function gridIntensityDoctor(): Promise<string> {
  const app = new App()
  const usesMongoDb = configLoader().CACHE_MODE === 'MONGODB'
  try {
    const report = formatCapabilityReport(
      await app.getGridIntensityCapabilities(),
    )
    const cachedPeriods = await cachedPeriodLines(app, usesMongoDb)
    return [report, ...cachedPeriods].join('\n')
  } finally {
    await shutdownDefaultResolver()
    if (usesMongoDb) {
      await MongoDbCacheManager.mongoClient?.close()
    }
  }
}

/**
 * The lines about the estimates cache. A cache that cannot be read does not
 * stop the doctor: the table is still printed, with the reason under it.
 */
const cachedPeriodLines = async (
  app: App,
  usesMongoDb: boolean,
): Promise<string[]> => {
  try {
    if (usesMongoDb) {
      await MongoDbCacheManager.createDbConnection()
    }
    return formatCachedPeriodCounts(await app.getCachedPeriodCounts())
  } catch (error) {
    return ['', `The estimates cache could not be read: ${error.message}`]
  }
}

const periods = (count: number): string =>
  `${count} cached ${count === 1 ? 'period' : 'periods'}`

/**
 * One line for each grouping that has cached periods, under a heading, and
 * nothing when there are none.
 */
export const formatCachedPeriodCounts = (
  counts: CachedPeriodCount[],
): string[] => {
  if (!counts.length) return []
  return [
    '',
    'Cached estimates:',
    ...counts.map(
      ({ groupBy, cachedPeriods, provisionalPeriods }) =>
        `  ${groupBy}: ${periods(cachedPeriods)}, ${provisionalPeriods} provisional`,
    ),
    ...(counts.some(({ provisionalPeriods }) => provisionalPeriods > 0)
      ? [
          'A provisional period holds rows whose grid intensity can still improve. The refresh-estimates command estimates such periods again.',
        ]
      : []),
  ]
}

const WINDOWS = [
  ['last24Hours', 'Last 24 hours'],
  ['last30Days', 'Last 30 days'],
  ['last12Months', 'Last 12 months'],
] as const

const NONE = '-'

const EXPLANATION =
  'Grid zone is the electricity grid the region is on, and source zone is the name the source has for it; a dash means there is none. ' +
  'Tiers are the best each source can deliver for a day of usage, the finest usage period CCF produces, in each window: B from hourly or daily intensity, C from monthly or annual intensity or from a day covered in part, D from the static annual factors. ' +
  'A percentage is the share of the days in the window that the source can serve, shown when that is not all of them. ' +
  'A source that needs acknowledgement is not used until it is listed in GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS.'

export const formatCapabilityReport = (report: CapabilityReport): string => {
  const header = [
    'Provider',
    'Region',
    'Grid zone',
    'Source',
    'Source zone',
    ...WINDOWS.map(([, title]) => title),
    'Licence',
    'Error',
  ]
  const rows = report.regions.flatMap((region) => {
    const lead = [region.provider, region.region, region.gridZoneId ?? NONE]
    if (!region.sources.length)
      return [[...lead, NONE, NONE, ...WINDOWS.map(() => NONE), NONE, '']]
    return region.sources.map((source) => [
      ...lead,
      source.sourceId,
      source.zoneId ?? NONE,
      ...WINDOWS.map(([name]) => tierCell(source, name)),
      source.licenceState,
      source.error ?? '',
    ])
  })
  const attributions = new Set(
    report.regions.flatMap((region) =>
      region.sources.flatMap((source) =>
        source.attribution
          ? [`  ${source.sourceId}: ${source.attribution}`]
          : [],
      ),
    ),
  )
  return [
    `Grid intensity capabilities at ${report.generatedAt.toISOString()}`,
    EXPLANATION,
    '',
    ...table([header, ...rows]),
    ...(attributions.size
      ? ['', 'Attribution:', ...[...attributions].sort()]
      : []),
  ].join('\n')
}

/** The tier, with the share of the window's days when that is not all. */
const tierCell = (
  source: SourceCapabilitySummary,
  window: (typeof WINDOWS)[number][0],
): string => {
  const tier = source.bestTier[window]
  if (tier === null) return NONE
  const coverage = source.coverage[window]
  return coverage < 1
    ? `${tier} (${Math.max(1, Math.floor(coverage * 100))}%)`
    : tier
}

/** Rows as lines of '| cell' columns, each as wide as its longest cell. */
const table = (rows: string[][]): string[] => {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  )
  return rows.map((row) =>
    row
      .map((cell, column) => `| ${cell.padEnd(widths[column])} `)
      .join('')
      .trimEnd(),
  )
}
