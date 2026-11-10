/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { addUtcMonths, Period, periodsCovering } from './granularity'
import {
  granularityFor,
  GridIntensityResolver,
  isWithinWindow,
  SourceView,
} from './GridIntensityResolver'
import { requiresAcknowledgement } from './licence'
import { deriveQualityTier } from './qualityTier'
import {
  CapabilityReport,
  CapabilityReporter,
  Granularity,
  LicenceDeclaration,
  LicenceState,
  LookbackWindows,
  ProviderRegion,
  QualityTier,
  SourceCapabilitySummary,
  ZoneCapability,
} from './types'

export interface CapabilityReporterOptions {
  /** The resolver whose sources, capability answers and failures to report. */
  resolver: Pick<GridIntensityResolver, 'sourceViews'>
  /** The provider regions to report on, from the app layer. */
  regions: ProviderRegion[]
  now?: () => Date
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The usage period the tiers are for. A day is the finest CCF produces
 * (GroupBy); hourly usage, and with it tier A, comes with design section 7.
 */
export const REPORT_USAGE_GRANULARITY: Granularity = 'day'

/**
 * The report behind the doctor command and GET /api/grid-intensity/capabilities
 * (design section 6.5): for each provider region, what each configured source
 * can deliver and under which licence state.
 *
 * It reads the resolver's capability answers and failures and calls no data
 * endpoint. Tiers come from each zone's capability (granularities and
 * lookback window) by the rules the resolver applies to a day of usage, so
 * they are what a source offers, not a record of what it returned. Points
 * already in the store from before a source's lookback window are used by
 * estimates but not counted here.
 */
export class GridIntensityCapabilityReporter implements CapabilityReporter {
  constructor(private readonly options: CapabilityReporterOptions) {}

  async capabilities(): Promise<CapabilityReport> {
    const { resolver, regions } = this.options
    const now = (this.options.now ?? (() => new Date()))()
    const report: CapabilityReport = { generatedAt: now, regions: [] }
    for (const { provider, region } of regions) {
      const views = await resolver.sourceViews(provider, region)
      report.regions.push({
        provider,
        region,
        sources: views.map((view) => summarise(view, now)),
      })
    }
    return report
  }
}

type Windows = Pick<SourceCapabilitySummary, 'bestTier' | 'coverage'>

const WINDOW_NAMES = ['last24Hours', 'last30Days', 'last12Months'] as const

const noData = (): Windows => ({
  bestTier: { last24Hours: null, last30Days: null, last12Months: null },
  coverage: { last24Hours: 0, last30Days: 0, last12Months: 0 },
})

const summarise = (view: SourceView, now: Date): SourceCapabilitySummary => {
  const { source, zoneId, capability, failure } = view
  const delivers = capability !== null && capability.granularities.length > 0
  // A zone whose probe failed before it ever answered may still be served
  // from the store, under the source's own licence.
  if (zoneId === null || (!delivers && failure === undefined))
    return {
      sourceId: source.id,
      zoneId,
      licenceState: 'unavailable',
      ...noData(),
    }
  const licence = capability?.licence ?? source.licence
  const error = errorOf(view)
  return {
    sourceId: source.id,
    zoneId,
    licenceState: licenceStateOf(licence, view.acknowledged),
    ...(delivers ? lookbackWindows(source.id, capability, now) : noData()),
    ...(licence.attribution && { attribution: licence.attribution }),
    ...(error && { error }),
  }
}

const licenceStateOf = (
  licence: LicenceDeclaration,
  acknowledged: boolean,
): LicenceState => {
  if (!requiresAcknowledgement(licence)) return 'open'
  return acknowledged ? 'acknowledged' : 'needs-acknowledgement'
}

/** The source's probe answer when it is not a clean one, and any failure. */
const errorOf = ({ status, failure }: SourceView): string | undefined => {
  const problems: string[] = []
  if (!status.reachable || !status.authenticated)
    problems.push(
      status.message ??
        (status.reachable ? 'not authenticated' : 'not reachable'),
    )
  if (failure) problems.push(failure)
  return problems.length ? problems.join('; ') : undefined
}

/**
 * Best tier and coverage for the last 24 hours, 30 days and 12 months: over
 * the UTC days that overlap each window, the best tier of any day the source
 * can serve, and the share of days it can serve.
 */
const lookbackWindows = (
  sourceId: string,
  capability: ZoneCapability,
  now: Date,
): Windows => {
  const starts: LookbackWindows<Date> = {
    last24Hours: new Date(now.getTime() - DAY_MS),
    last30Days: new Date(now.getTime() - 30 * DAY_MS),
    last12Months: addUtcMonths(now, -12),
  }
  // The 12-month window contains the other two.
  const days = periodsCovering(starts.last12Months, now, 'day').map((day) => ({
    end: day.end,
    tier: tierForDay(sourceId, capability, day),
  }))
  const windows = noData()
  for (const name of WINDOW_NAMES) {
    const tiers = days
      .filter((day) => day.end > starts[name])
      .map((day) => day.tier)
    // Tier letters sort best first.
    const served = tiers.filter((tier) => tier !== null).sort()
    windows.bestTier[name] = served[0] ?? null
    windows.coverage[name] = served.length / tiers.length
  }
  return windows
}

/**
 * The tier the resolver would give a day of usage from this source, going by
 * the zone's capability, or null when it could ask the source for nothing in
 * that day. A day it can ask for only in part is estimated (tier C).
 */
const tierForDay = (
  sourceId: string,
  capability: ZoneCapability,
  day: Period,
): QualityTier | null => {
  const granularity = granularityFor(
    capability,
    day.end,
    REPORT_USAGE_GRANULARITY,
  )
  const coveredMs = periodsCovering(day.start, day.end, granularity)
    .filter((period) => isWithinWindow(period, capability))
    .reduce(
      (ms, period) =>
        ms +
        Math.min(period.end.getTime(), day.end.getTime()) -
        Math.max(period.start.getTime(), day.start.getTime()),
      0,
    )
  if (coveredMs === 0) return null
  return deriveQualityTier({
    sourceId,
    isEstimated: coveredMs < DAY_MS,
    intensityGranularity: granularity,
    usageGranularity: REPORT_USAGE_GRANULARITY,
  })
}
