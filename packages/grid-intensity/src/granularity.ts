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

const addUtcMonths = (date: Date, months: number): Date => {
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
