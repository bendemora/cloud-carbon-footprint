/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { version } from '../../package.json'
import { MAX_G_CO2E_PER_KWH } from '../dataQuality'
import { PartialFetchError } from '../PartialFetchError'
import { gridZoneOf } from '../registry/gridZones'
import {
  CloudProvider,
  GridIntensitySource,
  Granularity,
  IntensityPoint,
  LicenceDeclaration,
  SourceStatus,
  ZoneCapability,
} from '../types'

/*
 * The NESO Carbon Intensity API as a grid intensity source, for Great
 * Britain. What the API serves, and why the source reads it this way, is in
 * docs/design/spikes/2026-11-neso.md: sections 4 and 7 are the findings and
 * section 8 the recommendations this file follows.
 */

export const NESO_SOURCE_ID = 'neso'
export const NESO_BASE_URL = 'https://api.carbonintensity.org.uk'

/** The national series: the only NESO series with outturn (actual) values. */
export const NESO_NATIONAL_ZONE = 'national'

/**
 * This source's zone for each grid zone of the registry (design section
 * 5.5). Great Britain resolves to the national series. NESO's regional
 * series are forecasts only and are not served (spike section 8.1).
 */
export const NESO_ZONES: { readonly [gridZone: string]: string } = {
  GB: NESO_NATIONAL_ZONE,
}

/** The start of the first whole UTC hour the national series has. */
export const NESO_EARLIEST = '2017-09-11T23:00:00.000Z'

/**
 * How long after an hour ends it is first offered, so that values that may
 * still change are not fetched and stored. In the spike an actual appeared
 * 12 to 14 minutes after its half hour and changed once more at about 43
 * minutes. One hour covers that; two leave a margin. Whether NESO revises a
 * value later is not known: spike section 9, point 1.
 */
export const NESO_HOLD_BACK_HOURS = 2

/** The longest range of one request that NESO documents. */
export const NESO_MAX_RANGE_DAYS = 14

/** How long a request may go unanswered before it is given up. */
export const NESO_TIMEOUT_MS = 30_000

/**
 * The least time between the start of one request and the start of the
 * next. NESO applies a rate limit, publishes no figure for it and may block
 * an application that makes a large number of calls (spike section 7.3). The
 * spike's requests were a second or more apart and were not throttled, so a
 * second is the one spacing there is evidence for.
 */
export const NESO_MIN_REQUEST_INTERVAL_MS = 1000

/**
 * Names the application and its version, and nothing else (spike section
 * 7.3). The version is this package's own, from its package.json, which is
 * two directories up from this file in the source tree and in the build.
 */
export const NESO_USER_AGENT = `cloud-carbon-footprint-grid-intensity/${version}`

/** CC BY 4.0 asks for the creator, a link, the licence and a note of changes. */
export const NESO_ATTRIBUTION =
  'Contains data from the Carbon Intensity API by National Energy System Operator (NESO), https://carbonintensity.org.uk, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Half-hourly values averaged to hours.'

export interface NesoSourceOptions {
  /** Default NESO_BASE_URL. No trailing slash. */
  baseUrl?: string
  /** Default: the global fetch, looked up at each request. */
  fetch?: typeof fetch
  /** Default: the system clock. */
  now?: () => Date
  /** Default NESO_MIN_REQUEST_INTERVAL_MS. 0 turns the spacing off. */
  minRequestIntervalMs?: number
  /** Waits between requests. Default: a timer. */
  sleep?: (milliseconds: number) => Promise<void>
}

const HALF_HOUR_MS = 30 * 60 * 1000
const HOUR_MS = 2 * HALF_HOUR_MS
const MAX_RANGE_MS = NESO_MAX_RANGE_DAYS * 24 * HOUR_MS
const GRANULARITY: Granularity = 'hour'
const PROBE_PATH = '/intensity'

/** What a request returned: the parsed JSON body of a 2xx answer. */
interface Answer {
  path: string
  status: number
  body: unknown
}

/**
 * Hourly carbon intensity of the electricity consumed in Great Britain, from
 * the national series of the NESO Carbon Intensity API. No key is needed.
 *
 * An hour is the mean of the outturn (`actual`) values of its two half
 * hours, and is given only when both exist. The forecast is never used, so
 * no point is estimated. An hour NESO has not settled yet is not offered:
 * capabilities() ends NESO_HOLD_BACK_HOURS before the present.
 *
 * The values are consumption-based (generation plus imports over demand,
 * corrected for losses) with direct CO2 factors. They are grams of CO2 per
 * kWh, not CO2e, although the field that carries them is named gCO2ePerKWh.
 *
 * An answer whose periods are all in a form the source does not know is a
 * failure, not an empty answer: a change of NESO's format then shows as a
 * warning and in the doctor, and not as a silent return to the static
 * factors.
 *
 * The source keeps no data between calls: the resolver stores the points
 * and remembers failures. It does keep its requests in line: they go out
 * one at a time, NESO_MIN_REQUEST_INTERVAL_MS apart, whichever call they
 * belong to.
 */
export class NesoSource implements GridIntensitySource {
  readonly id = NESO_SOURCE_ID
  readonly licence: LicenceDeclaration = {
    id: 'CC-BY-4.0',
    attribution: NESO_ATTRIBUTION,
    redistributable: true,
    retention: 'unlimited',
    termsUrl: 'https://github.com/carbon-intensity/terms',
  }

  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly now: () => Date
  private readonly minRequestIntervalMs: number
  private readonly sleep: (milliseconds: number) => Promise<void>
  /** Settles when the request before this one has been answered. */
  private lastInLine: Promise<unknown> = Promise.resolve()
  /** When the last request went out, by the source's clock. */
  private lastRequestAt = -Infinity

  constructor(options: NesoSourceOptions = {}) {
    this.baseUrl = options.baseUrl ?? NESO_BASE_URL
    this.fetchFn =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.now = options.now ?? (() => new Date())
    this.minRequestIntervalMs =
      options.minRequestIntervalMs ?? NESO_MIN_REQUEST_INTERVAL_MS
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  /**
   * Asks for one half hour, the latest. Only the form of the answer is
   * looked at, which is the form fetch() reads: the spike found the values
   * of this endpoint unreliable (section 4.5). The API has no
   * authentication, so `authenticated` follows `reachable`.
   */
  async probe(): Promise<SourceStatus> {
    try {
      const { path, status, body } = await this.request(PROBE_PATH)
      const unexpected = (what: string): SourceStatus =>
        unreachable(failure(path, `HTTP ${status} with ${what}`))
      if (!isObject(body) || !('data' in body))
        return unexpected('a body that has no data')
      if (!Array.isArray(body.data))
        return unexpected('data that is not a list')
      if (body.data.some((entry) => halfHourOf(entry) === undefined))
        return unexpected('a period that is not in the expected form')
      return { reachable: true, authenticated: true }
    } catch (error) {
      return unreachable(error)
    }
  }

  /** Region to grid zone in the registry, then grid zone to NESO's zone. */
  mapRegion(provider: CloudProvider, region: string): string | null {
    const gridZone = gridZoneOf(provider, region)
    return gridZone !== null && Object.hasOwn(NESO_ZONES, gridZone)
      ? NESO_ZONES[gridZone]
      : null
  }

  /** Worked out from the clock. No request is made. */
  async capabilities(zoneId: string): Promise<ZoneCapability | null> {
    if (zoneId !== NESO_NATIONAL_ZONE) return null
    const settledBefore = this.now().getTime() - NESO_HOLD_BACK_HOURS * HOUR_MS
    return {
      zoneId,
      granularities: [GRANULARITY],
      earliest: new Date(NESO_EARLIEST),
      // The end of the last whole UTC hour that ended a hold-back ago or more.
      latest: new Date(Math.floor(settledBefore / HOUR_MS) * HOUR_MS),
      bases: ['location-consumption'],
      licence: this.licence,
    }
  }

  /**
   * One point for each whole UTC hour in [start, end) whose two half hours
   * both have an actual value. The resolver asks for whole hours. A range of
   * more than NESO_MAX_RANGE_DAYS is read in consecutive requests, one after
   * another. When a request after the first fails, the error carries the
   * points of the part that was read (PartialFetchError).
   */
  async fetch(
    zoneId: string,
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<IntensityPoint[]> {
    if (granularity !== GRANULARITY)
      throw new Error(
        `NESO source only provides ${GRANULARITY} granularity, not ${granularity}`,
      )
    if (zoneId !== NESO_NATIONAL_ZONE)
      throw new Error(
        `NESO source has no zone ${zoneId}, only ${NESO_NATIONAL_ZONE}`,
      )

    const startMs = start.getTime()
    const endMs = end.getTime()
    const retrievedAt = this.now()
    /** The actual value of each half hour that has one, by its start. */
    const actuals = new Map<number, number>()

    // Only the two half hours of each whole UTC hour inside the range are
    // looked up, so nothing outside it is used. That leaves out the extra
    // half hour the API returns, the one that ends where a request starts,
    // and any period that does not start at minute 0 or 30.
    const pointsBefore = (untilMs: number): IntensityPoint[] => {
      const points: IntensityPoint[] = []
      const firstHour = Math.ceil(startMs / HOUR_MS) * HOUR_MS
      for (let hour = firstHour; hour + HOUR_MS <= untilMs; hour += HOUR_MS) {
        const first = actuals.get(hour)
        const second = actuals.get(hour + HALF_HOUR_MS)
        // An hour with a missing half is left out, never filled from the
        // forecast: the store keeps a point for good, so a stored forecast
        // would not be replaced by the actual (spike section 8.2, point 6).
        if (first === undefined || second === undefined) continue
        points.push({
          zoneId,
          periodStart: new Date(hour),
          periodEnd: new Date(hour + HOUR_MS),
          granularity: GRANULARITY,
          // The halves are equal in length, so the plain mean is
          // time-weighted.
          gCO2ePerKWh: (first + second) / 2,
          basis: 'location-consumption',
          factorType: 'direct',
          isEstimated: false,
          sourceId: this.id,
          retrievedAt,
        })
      }
      return points
    }

    for (let from = startMs; from < endMs; from += MAX_RANGE_MS) {
      const to = Math.min(from + MAX_RANGE_MS, endMs)
      try {
        const answer = await this.request(
          `/intensity/${formatDatetime(from)}/${formatDatetime(to)}`,
        )
        for (const { from: halfHour, actual } of halfHoursOf(answer))
          if (actual !== null) actuals.set(halfHour, actual)
      } catch (error) {
        // What the requests before this one gave is not thrown away.
        const read = pointsBefore(from)
        if (!read.length) throw error
        throw new PartialFetchError(textOf(error), read, { cause: error })
      }
    }
    return pointsBefore(endMs)
  }

  /**
   * GET a path of the API and parse the answer. Throws when the request
   * fails or is not answered in time, when the status is not 2xx, when the
   * body is not JSON, and when the body carries an `error` property, which
   * the API also sends with HTTP 200 (spike section 4.8). The message of a
   * body that is { message } and no error object is shown as well: the API
   * is served through a gateway (spike section 3), and that such a gateway
   * answers in that form when it refuses a request itself is inferred. No
   * such answer was recorded.
   */
  private async request(path: string): Promise<Answer> {
    const { ok, status, text } = await this.send(path)
    const body = parseJson(text)
    if (isObject(body) && 'error' in body)
      throw failure(path, `HTTP ${status}: ${errorMessageOf(body.error)}`)
    // A gateway in front of the API answers { message } and no error object.
    const said = messageOf(body)
    if (!ok)
      throw failure(path, said ? `HTTP ${status}: ${said}` : `HTTP ${status}`)
    if (body === NOT_JSON)
      throw failure(path, `HTTP ${status} with a body that is not JSON`)
    return { path, status, body }
  }

  /**
   * Sends a request when the one before it has been answered, and not
   * sooner than the interval after that one went out.
   */
  private send(
    path: string,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const answer = this.lastInLine.then(async () => {
      // Never longer than the interval: a clock that was set back since the
      // last request must not hold the next one up for the size of the step.
      const wait = Math.min(
        this.minRequestIntervalMs,
        this.lastRequestAt + this.minRequestIntervalMs - this.now().getTime(),
      )
      if (wait > 0) await this.sleep(wait)
      this.lastRequestAt = this.now().getTime()
      return this.sendNow(path)
    })
    // A failed request does not hold up the ones behind it.
    this.lastInLine = answer.catch(() => undefined)
    return answer
  }

  /** The status and the whole body, or a failure that says why not. */
  private async sendNow(
    path: string,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': NESO_USER_AGENT },
        signal: AbortSignal.timeout(NESO_TIMEOUT_MS),
      })
      const text = await response.text()
      return { ok: response.ok, status: response.status, text }
    } catch (error) {
      throw failure(path, reasonOf(error), error)
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const NOT_JSON = Symbol('not JSON')

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return NOT_JSON
  }
}

/** Every failure names NESO and the request, so a log line stands alone. */
const failure = (path: string, reason: string, cause?: unknown): Error =>
  new Error(
    `NESO Carbon Intensity API: GET ${path} failed: ${reason}`,
    cause === undefined ? undefined : { cause },
  )

const messageOf = (value: unknown): string | undefined =>
  isObject(value) && typeof value.message === 'string'
    ? value.message
    : undefined

/** What was thrown, as text: an error's message, or the value itself. */
const textOf = (thrown: unknown): string => messageOf(thrown) ?? String(thrown)

const unreachable = (thrown: unknown): SourceStatus => ({
  reachable: false,
  authenticated: false,
  message: textOf(thrown),
})

/**
 * Why a request got no answer. Node's fetch reports a network failure as
 * "fetch failed" and puts what went wrong (the DNS or socket error) in the
 * cause, and it rejects with a TimeoutError when the timeout signal fires.
 * Errors are read by their properties, not with instanceof.
 */
const reasonOf = (error: unknown): string => {
  if (isObject(error) && error.name === 'TimeoutError')
    return `no answer within ${NESO_TIMEOUT_MS / 1000} seconds`
  const cause = isObject(error) ? causeOf(error.cause) : ''
  return cause ? `${textOf(error)}: ${cause}` : textOf(error)
}

/**
 * What a cause says. When a host has several addresses and none can be
 * reached, the cause is an AggregateError with an empty message, a code and
 * one error for each address.
 */
const causeOf = (cause: unknown): string => {
  const message = messageOf(cause)
  if (message || !isObject(cause)) return message ?? ''
  const attempts = Array.isArray(cause.errors)
    ? cause.errors.map(messageOf).filter(Boolean)
    : []
  const code = typeof cause.code === 'string' ? cause.code : ''
  return [code, attempts.join('; ')].filter(Boolean).join(': ')
}

/** The message of the API's error object: { code, message }. */
const errorMessageOf = (error: unknown): string =>
  messageOf(error) ?? JSON.stringify(error)

/**
 * The periods of a range answer. A range with no data comes back as an
 * empty list, or as the JSON literal null when it lies long before the
 * series starts; both mean no data (spike section 4.8).
 */
const entriesOf = ({ path, status, body }: Answer): unknown[] => {
  if (body === null) return []
  if (isObject(body) && Array.isArray(body.data)) return body.data
  throw failure(path, `HTTP ${status} with a body that is not { data: [...] }`)
}

/** A datetime as the API takes and writes it: YYYY-MM-DDThh:mmZ. */
const formatDatetime = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16)}Z`

/**
 * A UTC datetime with the Z. The API writes minutes; seconds are read too,
 * so that a change of precision would not empty every answer.
 */
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/

/** NaN when the value is not such a datetime. */
const parseDatetime = (value: unknown): number =>
  typeof value === 'string' && DATETIME.test(value) ? Date.parse(value) : NaN

/** A half hour of an answer: its start, and its actual value if it has a usable one. */
interface HalfHour {
  from: number
  actual: number | null
}

/**
 * The half hour an entry of `data` describes, or undefined when the entry
 * is not in the form the spike recorded: an object with `from` and `to` 30
 * minutes apart and an `intensity` whose `actual` is a number or null.
 * Every period the spike saw is 30 minutes long.
 *
 * A missing actual is null in the API's answers. A value of 0 or less
 * counts as missing too: the one 0 found in the spike is taken to be an
 * artefact, and a real zero is not possible while gas and biomass run
 * (spike section 4.7). So does a value above the data quality bound, which
 * would otherwise pass when the hour's other half is low.
 */
const halfHourOf = (entry: unknown): HalfHour | undefined => {
  if (!isObject(entry) || !isObject(entry.intensity)) return undefined
  const from = parseDatetime(entry.from)
  if (parseDatetime(entry.to) - from !== HALF_HOUR_MS) return undefined
  const { actual } = entry.intensity
  if (actual === null) return { from, actual: null }
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return undefined
  const usable = actual > 0 && actual <= MAX_G_CO2E_PER_KWH
  return { from, actual: usable ? actual : null }
}

/**
 * The half hours of a range answer that are in the expected form. The others
 * are left out, which leaves their hours out. An answer with periods of
 * which none is in that form is a failure: the format has changed, and the
 * hours are not missing.
 */
const halfHoursOf = (answer: Answer): HalfHour[] => {
  const entries = entriesOf(answer)
  const halfHours = entries
    .map(halfHourOf)
    .filter((halfHour): halfHour is HalfHour => halfHour !== undefined)
  if (entries.length && !halfHours.length)
    throw failure(
      answer.path,
      `HTTP ${answer.status} with ${entries.length} period${entries.length === 1 ? '' : 's'}, none of them in the expected form`,
    )
  return halfHours
}
