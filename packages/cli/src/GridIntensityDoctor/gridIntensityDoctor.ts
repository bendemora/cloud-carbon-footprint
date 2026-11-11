/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { App } from '@cloud-carbon-footprint/app'
import {
  CapabilityReport,
  shutdownDefaultResolver,
  SourceCapabilitySummary,
} from '@cloud-carbon-footprint/grid-intensity'

/**
 * The grid intensity doctor (design section 6.5): what each configured
 * source can deliver for every provider region, as a table. It needs no
 * cloud credentials.
 */
export default async function gridIntensityDoctor(): Promise<string> {
  try {
    return formatCapabilityReport(
      await new App().getGridIntensityCapabilities(),
    )
  } finally {
    await shutdownDefaultResolver()
  }
}

const WINDOWS = [
  ['last24Hours', 'Last 24 hours'],
  ['last30Days', 'Last 30 days'],
  ['last12Months', 'Last 12 months'],
] as const

const NONE = '-'

const EXPLANATION =
  'Tiers are the best each source can deliver for a day of usage, the finest usage period CCF produces, in each window: B from hourly or daily intensity, C from monthly or annual intensity or from a day covered in part, D from the static annual factors. ' +
  'A percentage is the share of the days in the window that the source can serve, shown when that is not all of them. ' +
  'A source that needs acknowledgement is not used until it is listed in GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS.'

export const formatCapabilityReport = (report: CapabilityReport): string => {
  const legacy = report.legacyElectricityMaps
  const header = [
    'Provider',
    'Region',
    ...(legacy ? ['Electricity Maps v3 zone'] : []),
    'Source',
    'Zone',
    ...WINDOWS.map(([, title]) => title),
    'Licence',
    'Error',
  ]
  const rows = report.regions.flatMap((region) => {
    const lead = [
      region.provider,
      region.region,
      ...(legacy ? [region.legacyElectricityMapsZoneId ?? NONE] : []),
    ]
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
    ...(legacy ? ['', legacy.message] : []),
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
