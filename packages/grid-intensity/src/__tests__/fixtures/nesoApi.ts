/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'fs'
import { join } from 'path'

/*
 * A stand-in for the NESO Carbon Intensity API in tests. It answers `fetch`
 * from the recorded exchanges in ./neso (see the README there) and never
 * touches the network. A request for a URL it was not told about is
 * rejected and remembered, and assertNoUnknownRequests() then fails the
 * test, also when the code under test caught the rejection.
 */

export const NESO_API = 'https://api.carbonintensity.org.uk'

/** One recorded exchange: the format is described in ./neso/README.md. */
export interface NesoFixture {
  description: string
  licence: string
  attribution: string
  recordedAt: string
  request: { method: string; url: string; headers: Record<string, string> }
  response: {
    status: number
    headers: Record<string, string>
    body: unknown
  }
}

export const nesoFixture = (name: string): NesoFixture =>
  JSON.parse(readFileSync(join(__dirname, 'neso', `${name}.json`), 'utf8'))

/** One period of a national range answer, as the API writes it. */
export interface NesoPeriod {
  from: string
  to: string
  intensity: { forecast: number; actual: number | null; index: string }
}

const HALF_HOUR_MS = 30 * 60 * 1000

/** A datetime as the API writes it: YYYY-MM-DDThh:mmZ. */
const nesoDatetime = (date: Date): string =>
  `${date.toISOString().slice(0, 16)}Z`

/**
 * A forecast far from any actual value the tests use, so that a result made
 * from a forecast would not match the expected one.
 */
const GENERATED_FORECAST = 999

/**
 * The body of a national range answer, generated in the recorded shape for
 * tests that need more periods than the fixtures hold. As the API does, it
 * gives every half hour whose end lies between `from` and `to`, both
 * inclusive, so an aligned range starts with the half hour that ends at
 * `from` (compare neso/national-range.json).
 */
export const generatedRange = (
  from: Date,
  to: Date,
  actualOf: (periodStart: Date) => number | null,
): { data: NesoPeriod[] } => {
  const data: NesoPeriod[] = []
  const firstEnd = Math.ceil(from.getTime() / HALF_HOUR_MS) * HALF_HOUR_MS
  for (let end = firstEnd; end <= to.getTime(); end += HALF_HOUR_MS) {
    const start = new Date(end - HALF_HOUR_MS)
    data.push({
      from: nesoDatetime(start),
      to: nesoDatetime(new Date(end)),
      intensity: {
        forecast: GENERATED_FORECAST,
        actual: actualOf(start),
        index: 'moderate',
      },
    })
  }
  return { data }
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

type Responder = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>

const DATETIME = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z'
const RANGE_URL = new RegExp(
  `^${NESO_API.replace(/\./g, '\\.')}/intensity/(${DATETIME})/(${DATETIME})$`,
)

export const mockNesoApi = () => {
  const routes = new Map<string, Responder>()
  const requests: { url: string; init: RequestInit | undefined }[] = []
  const unknownUrls: string[] = []
  let generated: Responder | undefined
  let inFlight = 0
  let mostInFlight = 0

  const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      const respond =
        routes.get(url) ?? (RANGE_URL.test(url) ? generated : undefined)
      if (!respond) {
        unknownUrls.push(url)
        throw new Error(`The NESO stand-in has no answer for ${url}`)
      }
      inFlight++
      mostInFlight = Math.max(mostInFlight, inFlight)
      try {
        // Answer on a later turn of the event loop, as a real request does,
        // so that requests sent in parallel would be seen to overlap.
        await new Promise((resolve) => setImmediate(resolve))
        return await respond(url, init)
      } finally {
        inFlight--
      }
    },
  )

  const serveAs = (url: string, { response }: NesoFixture): void => {
    routes.set(
      url,
      () =>
        new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: response.headers,
        }),
    )
  }

  return {
    /** Give this to the source as `fetch`, or put it in global.fetch. */
    fetch: fetchMock,
    /** Answer the URL the fixture recorded with the response it recorded. */
    serve: (fixture: NesoFixture): void =>
      serveAs(fixture.request.url, fixture),
    /**
     * Answer another URL with the fixture's response: for a fixture cut from
     * a range longer than the source ever asks for, and for the error
     * fixtures, whose own requests the source never makes.
     */
    serveAs,
    /** Answer a URL with whatever the function returns or throws. */
    respondTo: (url: string, respond: Responder): void => {
      routes.set(url, respond)
    },
    /**
     * Answer every national range URL that has no answer of its own with a
     * generated body (see generatedRange).
     */
    generate: (actualOf: (periodStart: Date) => number | null): void => {
      generated = (url) => {
        const [, from, to] = RANGE_URL.exec(url) as RegExpExecArray
        return jsonResponse(
          generatedRange(new Date(from), new Date(to), actualOf),
        )
      }
    },
    /** The URLs requested so far, in order. */
    urls: (): string[] => requests.map((request) => request.url),
    /** The options of each request so far, in order. */
    inits: (): (RequestInit | undefined)[] =>
      requests.map((request) => request.init),
    /** The largest number of requests that were under way at one time. */
    mostInFlight: (): number => mostInFlight,
    /** Call after each test. */
    assertNoUnknownRequests: (): void => {
      expect(unknownUrls).toEqual([])
    },
  }
}

export type NesoApiMock = ReturnType<typeof mockNesoApi>
