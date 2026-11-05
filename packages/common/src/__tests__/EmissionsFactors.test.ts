/*
 * © 2021 Thoughtworks, Inc.
 */

import {
  getElectricityMapsData,
  getEmissionsFactors,
  zoneIntensityFactors,
} from '../EmissionsFactors'
import { Logger } from '../index'

const { Response } = jest.requireActual('node-fetch')
jest.mock('../index', () => ({
  ...(jest.requireActual('../index') as Record<string, unknown>),
  configLoader: jest.fn().mockImplementation(() => {
    return {
      ELECTRICITY_MAPS_TOKEN: 'testToken',
    }
  }),
}))

describe('getEmissionsFactors', () => {
  const emissionsFactors = { default: 0.5 }
  const mappedRegionsToElectricityMapZones = { 'region-1': 'zone-1' }

  const logger = { warn: jest.fn() } as unknown as Logger

  beforeEach(() => {
    jest.clearAllMocks()
    // Clear the cache before each test
    Object.keys(zoneIntensityFactors).forEach(
      (key) => delete zoneIntensityFactors[key],
    )
  })

  it('returns default emissions factors if there is no zone for the region', async () => {
    const result = await getEmissionsFactors(
      'region-2',
      '2022-01-01T00:00:00.000Z',
      emissionsFactors,
      mappedRegionsToElectricityMapZones,
      logger,
    )
    expect(result).toEqual(emissionsFactors)
  })

  it('returns cached emissions factors if they exist', async () => {
    zoneIntensityFactors['2022-01-01T00:00:00.000Z'] = { 'zone-1': 0.1 }
    const result = await getEmissionsFactors(
      'region-1',
      '2022-01-01T00:00:00.000Z',
      emissionsFactors,
      mappedRegionsToElectricityMapZones,
      logger,
    )
    expect(result).toEqual({ 'region-1': 0.1 })
  })

  it('returns carbon intensity values from Electricity Maps (gCO2eq/kWh) in t/kWh if there is no cached value for the zone', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'some-token' }),
    } as any)

    const response = {
      carbonIntensity: 300, // gCO2eq/kWh
    }
    ;(fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(
      new Response(JSON.stringify(response), {
        url: 'url',
        status: 200,
        statusText: 'OK',
      }),
    )

    const result = await getEmissionsFactors(
      'region-1',
      '2022-01-01T00:00:00.000Z',
      emissionsFactors,
      mappedRegionsToElectricityMapZones,
      logger,
    )

    expect(result).toEqual({ 'region-1': 0.0003 })
    expect(zoneIntensityFactors['2022-01-01T00:00:00.000Z']['zone-1']).toEqual(
      0.0003,
    )
  })
})

describe('getElectricityMapsData', () => {
  const electricityMapsZone = 'testZone'
  const dateTime = '2022-01-01T00:00:00.000Z'
  const response = {
    carbonIntensity: 300,
  }

  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'some-token' }),
    } as any)

    jest.clearAllMocks()
  })

  it('should make a request to electricity maps and return the response', async () => {
    ;(fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(
      new Response(JSON.stringify(response), {
        url: 'url',
        status: 200,
        statusText: 'OK',
      }),
    )

    const result = await getElectricityMapsData(electricityMapsZone, dateTime)

    expect(result).toEqual(response)
    expect(fetch).toHaveBeenCalledWith(
      `https://api.electricitymap.org/v3/carbon-intensity/past?zone=${electricityMapsZone}&datetime=${dateTime}`,
      {
        headers: {
          'auth-token': 'testToken',
        },
      },
    )
  })

  // Bodies recorded from the live API on 2026-11-05.
  const invalidToken =
    '{"error":"Invalid auth-token","message":"The provided token is invalid. If this token used to work, please visit https://help.electricitymaps.com to get support"}'
  const zoneNotInPlan = {
    error:
      'Request unauthorized for zoneKey=GB,requestType=past,dataType=carbon-intensity.',
    message:
      'You do not have access to this specific endpoint for this specific zone. Please visit https://help.electricitymaps.com if this is a mistake',
  }

  it.each([
    [401, invalidToken],
    [401, 'Unauthorized'],
    [401, '{"error":"Some other reason"}'],
    [500, 'Internal Server Error'],
    [503, ''],
  ])(
    'throws for HTTP %s %s, which no other zone or date would answer differently',
    async (status, body) => {
      ;(fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(
        new Response(body, { url: 'url', status }),
      )
      await expect(
        getElectricityMapsData(electricityMapsZone, dateTime),
      ).rejects.toThrow(
        `Electricity Maps request failed. Reason: Electricity Maps answered HTTP ${status}`,
      )
    },
  )

  it('makes getEmissionsFactors reject on HTTP 401, with the answer in the message, instead of returning the default factors', async () => {
    ;(fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(
      new Response(invalidToken, { url: 'url', status: 401 }),
    )
    await expect(
      getEmissionsFactors(
        'region-1',
        dateTime,
        { default: 0.5 },
        { 'region-1': electricityMapsZone },
        { warn: jest.fn() } as unknown as Logger,
      ),
    ).rejects.toThrow(
      'Failed to get data from Electricity Maps. Reason Electricity Maps request failed. Reason: Electricity Maps answered HTTP 401: {"error":"Invalid auth-token"',
    )
  })

  it('returns the body of a 401 for a zone the token cannot access, so that zone falls back', async () => {
    // A valid token without access to the zone or endpoint also gets a 401.
    ;(fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(
      new Response(JSON.stringify(zoneNotInPlan), { url: 'url', status: 401 }),
    )
    await expect(
      getElectricityMapsData(electricityMapsZone, dateTime),
    ).resolves.toEqual(zoneNotInPlan)
  })

  it('makes getEmissionsFactors return the default factors, warning, for a zone the token cannot access', async () => {
    ;(fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(
      new Response(JSON.stringify(zoneNotInPlan), { url: 'url', status: 401 }),
    )
    const defaults = { default: 0.5 }
    const logger = { warn: jest.fn() } as unknown as Logger
    await expect(
      getEmissionsFactors(
        'region-1',
        dateTime,
        defaults,
        { 'region-1': electricityMapsZone },
        logger,
      ),
    ).resolves.toBe(defaults)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it.each([
    [400, { status: 'error', message: "Zone 'XX-NOPE' does not exist." }],
    [403, { error: 'Forbidden' }],
  ])(
    'returns the body of other error answers (HTTP %s), so that zone falls back',
    async (status, body) => {
      ;(fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(
        new Response(JSON.stringify(body), { url: 'url', status }),
      )
      await expect(
        getElectricityMapsData(electricityMapsZone, dateTime),
      ).resolves.toEqual(body)
    },
  )

  it('should throw an error if the request to electricity maps fails', async () => {
    const errorMessage = 'testError'
    ;(fetch as jest.MockedFunction<typeof fetch>).mockRejectedValue(
      new Error(errorMessage),
    )

    await expect(
      getElectricityMapsData(electricityMapsZone, dateTime),
    ).rejects.toThrow(
      `Electricity Maps request failed. Reason: ${errorMessage}.`,
    )
  })
})
