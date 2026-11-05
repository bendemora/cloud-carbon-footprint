/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { Granularity } from './types'

/** Finest first. */
export const GRANULARITIES: readonly Granularity[] = [
  'hour',
  'day',
  'month',
  'year',
]

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** True when `a` is the same length as, or shorter than, `b`. */
export const isAtLeastAsFine = (a: Granularity, b: Granularity): boolean =>
  GRANULARITIES.indexOf(a) <= GRANULARITIES.indexOf(b)

/** The start of the UTC hour, day, month or year containing `date`. */
export const startOfPeriod = (date: Date, granularity: Granularity): Date => {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  switch (granularity) {
    case 'hour':
      return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS)
    case 'day':
      return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS)
    case 'month':
      return new Date(Date.UTC(year, month, 1))
    case 'year':
      return new Date(Date.UTC(year, 0, 1))
  }
}

/** `date` plus a number of calendar months in UTC, clamped to the month end. */
export const addUtcMonths = (date: Date, months: number): Date => {
  const target = new Date(date.getTime())
  const totalMonths = date.getUTCMonth() + months
  const year = date.getUTCFullYear() + Math.floor(totalMonths / 12)
  const month = ((totalMonths % 12) + 12) % 12
  const daysInTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  target.setUTCFullYear(
    year,
    month,
    Math.min(date.getUTCDate(), daysInTargetMonth),
  )
  return target
}

/**
 * `date` plus one hour, day, month or year in UTC. Month and year steps clamp
 * to the last day of a shorter month (31 January plus a month is 28 or 29
 * February).
 */
export const addPeriod = (date: Date, granularity: Granularity): Date => {
  switch (granularity) {
    case 'hour':
      return new Date(date.getTime() + HOUR_MS)
    case 'day':
      return new Date(date.getTime() + DAY_MS)
    case 'month':
      return addUtcMonths(date, 1)
    case 'year':
      return addUtcMonths(date, 12)
  }
}

/**
 * The granularity a usage period corresponds to, by length: up to an hour is
 * 'hour', up to a day 'day', up to 31 days 'month', longer 'year'. A week is
 * 'month'-sized: longer than a day, and coarser than daily intensity.
 */
export const usageGranularityOf = (start: Date, end: Date): Granularity => {
  const ms = end.getTime() - start.getTime()
  if (ms <= HOUR_MS) return 'hour'
  if (ms <= DAY_MS) return 'day'
  if (ms <= 31 * DAY_MS) return 'month'
  return 'year'
}

/** The shortest period of each granularity: February, a common year. */
const SHORTEST_MS: Record<Granularity, number> = {
  hour: HOUR_MS,
  day: DAY_MS,
  month: 28 * DAY_MS,
  year: 365 * DAY_MS,
}

/**
 * The coarsest granularity whose shortest period fits within [start, end):
 * the coarsest intensity data still at least as fine as the usage period
 * (design section 6.2, step 2). A week is 'day' and a quarter 'month', so
 * monthly data is too coarse for a week and annual data for a quarter.
 * Anything shorter than a day is 'hour'.
 */
export const coarsestWithin = (start: Date, end: Date): Granularity => {
  const ms = end.getTime() - start.getTime()
  return (
    [...GRANULARITIES].reverse().find((g) => SHORTEST_MS[g] <= ms) ?? 'hour'
  )
}

export interface Period {
  start: Date
  end: Date
}

/**
 * The calendar-aligned periods of the given granularity that overlap
 * [start, end). The first period may begin before `start` and the last may
 * end after `end`.
 */
export const periodsCovering = (
  start: Date,
  end: Date,
  granularity: Granularity,
): Period[] => {
  const periods: Period[] = []
  if (start >= end) return periods
  let cursor = startOfPeriod(start, granularity)
  while (cursor < end) {
    const next = addPeriod(cursor, granularity)
    periods.push({ start: cursor, end: next })
    cursor = next
  }
  return periods
}
