/*
 * © 2021 Thoughtworks, Inc.
 */

import { constants } from 'buffer'
import { IncomingMessage } from 'http'
import express from 'express'
import request from 'supertest'

import {
  EstimationResult,
  EmissionRatioResult,
  GroupBy,
  RecommendationResult,
} from '@cloud-carbon-footprint/common'

import { createRouter } from '../api'

const rowWithProvenance = {
  cloudProvider: 'AWS',
  kilowattHours: 0.0123456789012,
  co2e: 0.00000412345678901,
  cost: 1.23456789,
  usesAverageCPUConstant: false,
  accountId: '123456789012',
  accountName: '123456789012',
  serviceName: 'AmazonEC2',
  region: 'us-east-1',
  provenance: {
    sourceId: 'static',
    zoneId: 'aws:us-east-1',
    granularity: 'year',
    basis: 'location-production',
    factorType: 'direct',
    isEstimated: false,
    licenceId: 'open-attribution',
    qualityTier: 'D',
    gCO2ePerKWh: 379.069,
    modelVersion: 'unversioned',
  },
}

const oneDayOfEstimates = (day: string, serviceEstimates: unknown[]) =>
  ({
    timestamp: new Date(day),
    serviceEstimates,
    periodStartDate: new Date(day),
    periodEndDate: new Date(`${day}T23:59:59.000Z`),
    groupBy: GroupBy.day,
  }) as EstimationResult

/**
 * A response parser that keeps only the length and the first and last bytes
 * of the body, for bodies too long to hold in one string.
 */
const summariseBody =
  (headBytes: number, tailBytes: number) =>
  (
    res: IncomingMessage,
    callback: (err: Error | null, body: unknown) => void,
  ) => {
    let length = 0
    let head = Buffer.alloc(0)
    let tail = Buffer.alloc(0)
    res.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (head.length < headBytes)
        head = Buffer.concat([head, chunk]).subarray(0, headBytes)
      tail = Buffer.concat([tail, chunk])
      tail = tail.subarray(Math.max(0, tail.length - tailBytes))
    })
    res.on('end', () =>
      callback(null, {
        length,
        head: head.toString(),
        tail: tail.toString(),
      }),
    )
    res.on('error', (err) => callback(err, undefined))
  }

const mockGetCostAndEstimates = jest.fn()
const mockGetEmissionsFactors = jest.fn()
const mockGetRecommendations = jest.fn()

jest.mock('@cloud-carbon-footprint/app', () => ({
  ...(jest.requireActual('@cloud-carbon-footprint/app') as Record<
    string,
    unknown
  >),
  App: jest.fn().mockImplementation(() => {
    return {
      getCostAndEstimates: mockGetCostAndEstimates,
      getEmissionsFactors: mockGetEmissionsFactors,
      getRecommendations: mockGetRecommendations,
    }
  }),
}))

describe('api', () => {
  let server: express.Express
  const originalConsoleError = console.error

  beforeEach(() => {
    server = express()
    server.use(createRouter())
  })

  describe('/footprint', () => {
    it('returns footprint estimates for a period of time', async () => {
      //setup
      const startDate = '2020-07-12'
      const endDate = '2020-07-13'

      const expectedResponse: EstimationResult[] = []
      mockGetCostAndEstimates.mockResolvedValueOnce(expectedResponse)

      //run
      const response = await request(server).get(
        encodeURI(`/footprint?start=${startDate}&end=${endDate}`),
      )

      //assert
      expect(response.status).toBe(200)
      expect(response.body).toEqual(expectedResponse)
    })

    it('answers with the JSON text of the estimates', async () => {
      const estimates = [
        oneDayOfEstimates('2020-07-12', [rowWithProvenance]),
        oneDayOfEstimates('2020-07-13', []),
      ]
      mockGetCostAndEstimates.mockResolvedValueOnce(estimates)

      const response = await request(server).get(
        '/footprint?start=2020-07-12&end=2020-07-13',
      )

      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toBe(
        'application/json; charset=utf-8',
      )
      expect(response.text).toEqual(JSON.stringify(estimates))
    })

    it('streams estimates whose JSON is longer than the longest string Node can hold', async () => {
      // About 1.1 million rows with provenance in one day. The array holds
      // one row object many times, so the test needs little memory.
      const rowJson = JSON.stringify(rowWithProvenance)
      const rowCount = Math.ceil(constants.MAX_STRING_LENGTH / rowJson.length)
      const day = oneDayOfEstimates(
        '2020-07-12',
        new Array(rowCount).fill(rowWithProvenance),
      )
      mockGetCostAndEstimates.mockResolvedValueOnce([day])

      const [before, after] = JSON.stringify([
        { ...day, serviceEstimates: [] },
      ]).split('"serviceEstimates":[]')
      const expectedHead = `${before}"serviceEstimates":[${rowJson},${rowJson}`
      const expectedTail = `${rowJson},${rowJson}]${after}`
      const expectedLength =
        before.length +
        '"serviceEstimates":[]'.length +
        rowCount * rowJson.length +
        (rowCount - 1) +
        after.length

      const response = await request(server)
        .get('/footprint?start=2020-07-12&end=2020-07-12')
        .buffer(true)
        .maxResponseSize(2 * constants.MAX_STRING_LENGTH)
        .parse(summariseBody(expectedHead.length, expectedTail.length))

      expect(response.status).toBe(200)
      expect(expectedLength).toBeGreaterThan(constants.MAX_STRING_LENGTH)
      expect(response.body).toEqual({
        length: expectedLength,
        head: expectedHead,
        tail: expectedTail,
      })
    }, 120000)

    it('returns footprint estimates with filter queries', async () => {
      //setup
      const startDate = '2020-07-12'
      const endDate = '2020-07-13'
      const filters = {
        cloudProviders: ['aws, gcp'],
        services: ['service1', 'service2'],
        regions: ['us-east-1', 'us-east2'],
      }
      const tags = { 'aws:createdby': 'user', 'aws:env': 'prod' }

      // Add each filter to request url
      let requestUrl = `/footprint?start=${startDate}&end=${endDate}`
      for (const query in filters) {
        filters[query].forEach(
          (filter) => (requestUrl += `&${query}=${filter}`),
        )
      }
      const tagKeys = Object.keys(tags)
      tagKeys.forEach((key) => (requestUrl += `&tags[${key}]=${tags[key]}`))

      const expectedResponse: EstimationResult[] = []
      mockGetCostAndEstimates.mockResolvedValueOnce(expectedResponse)

      //run
      const response = await request(server).get(
        encodeURI(`/footprint?start=${startDate}&end=${endDate}`),
      )

      //assert
      expect(response.status).toBe(200)
      expect(response.body).toEqual(expectedResponse)
    })

    describe('error handling', () => {
      beforeEach(() => (console.error = jest.fn()))
      afterEach(() => (console.error = originalConsoleError))

      it('returns bad request if start date is not specified', async () => {
        //setup
        const endDate = '2020-07-13'

        //run
        const response = await request(server).get(
          encodeURI(`/footprint?end=${endDate}`),
        )

        //assert
        expect(response.status).toBe(400)
      })

      it('returns bad request if end date is not specified', async () => {
        //setup
        const startDate = '2020-07-12'

        //run
        const response = await request(server).get(
          encodeURI(`/footprint?start=${startDate}`),
        )

        //assert
        expect(response.status).toBe(400)
      })

      it('returns server error if unexpected error happens', async () => {
        //setup
        const startDate = '2020-07-12'
        const endDate = '2020-07-13'

        //run
        mockGetCostAndEstimates.mockRejectedValueOnce(new Error('error'))
        const response = await request(server).get(
          encodeURI(`/footprint?start=${startDate}&end=${endDate}`),
        )

        //assert
        expect(response.status).toBe(500)
      })

      it('returns server error if the estimates cannot be written as JSON', async () => {
        mockGetCostAndEstimates.mockResolvedValueOnce([
          oneDayOfEstimates('2020-07-12', [
            { ...rowWithProvenance, cost: BigInt(1) },
          ]),
        ])

        const response = await request(server).get(
          '/footprint?start=2020-07-12&end=2020-07-12',
        )

        expect(response.status).toBe(500)
        expect(response.text).toBe('Internal Server Error')
      })

      it('closes the connection if writing the estimates fails part way through', async () => {
        // Enough rows that the start of the response is sent before the
        // row that cannot be written as JSON.
        mockGetCostAndEstimates.mockResolvedValueOnce([
          oneDayOfEstimates('2020-07-12', [
            ...new Array(10000).fill(rowWithProvenance),
            { ...rowWithProvenance, cost: BigInt(1) },
          ]),
        ])

        await expect(
          request(server).get('/footprint?start=2020-07-12&end=2020-07-12'),
        ).rejects.toThrow()
      })

      it('throw 400 error if invalid groupBy is passed', async () => {
        //setup
        const startDate = '2020-07-12'
        const endDate = '2020-07-13'
        const groupBy = 'hello'

        const expectedResponse: EstimationResult[] = []
        mockGetCostAndEstimates.mockResolvedValueOnce(expectedResponse)

        //run
        const response = await request(server).get(
          encodeURI(
            `/footprint?start=${startDate}&end=${endDate}&groupBy=${groupBy}`,
          ),
        )

        //assert
        expect(response.status).toBe(400)
      })

      it('throw 400 error if invalid limit or skip is passed', async () => {
        //setup
        const startDate = '2020-07-12'
        const endDate = '2020-07-13'
        const limit = 'limit'
        const skip = 'skip'

        const expectedResponse: EstimationResult[] = []
        mockGetCostAndEstimates.mockResolvedValueOnce(expectedResponse)

        //run
        const response = await request(server).get(
          encodeURI(
            `/footprint?start=${startDate}&end=${endDate}&limit=${limit}&skip=${skip}`,
          ),
        )

        //assert
        expect(response.status).toBe(400)
      })
    })
  })

  describe('/regions/emissions-factors', () => {
    it('returns data for regional emissions factors', async () => {
      const expectedResponse: EmissionRatioResult[] = [
        {
          cloudProvider: 'AWS',
          region: 'awsRegion1',
          mtPerKwHour: 1,
        },
        {
          cloudProvider: 'AWS',
          region: 'awsRegion2',
          mtPerKwHour: 2,
        },
        {
          cloudProvider: 'GCP',
          region: 'gcpRegion1',
          mtPerKwHour: 3,
        },
        {
          cloudProvider: 'GCP',
          region: 'gcpRegion2',
          mtPerKwHour: 4,
        },
      ]

      mockGetEmissionsFactors.mockResolvedValueOnce(expectedResponse)
      const response = await request(server).get(
        encodeURI(`/regions/emissions-factors`),
      )

      expect(response.status).toBe(200)
      expect(response.body).toEqual(expectedResponse)
    })

    describe('error handling', () => {
      beforeEach(() => (console.error = jest.fn()))
      afterEach(() => (console.error = originalConsoleError))

      it('returns server error if unexpected error happens', async () => {
        mockGetEmissionsFactors.mockRejectedValueOnce(new Error('error'))
        const response = await request(server).get(
          encodeURI(`/regions/emissions-factors`),
        )

        expect(response.status).toBe(500)
      })
    })
  })

  describe('/recommendations', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })
    it('returns data for recommendations', async () => {
      const expectedResponse: RecommendationResult[] = []

      mockGetRecommendations.mockResolvedValueOnce(expectedResponse)
      const response = await request(server).get(encodeURI('/recommendations'))

      expect(response.status).toBe(200)
      expect(response.body).toEqual(expectedResponse)
    })

    it('returns data when a Cross Instance Family AWS recommendation target is given', async () => {
      const expectedResponse: RecommendationResult[] = []

      mockGetRecommendations.mockResolvedValue(expectedResponse)
      const response = await request(server).get(
        encodeURI(
          '/recommendations?awsRecommendationTarget=CROSS_INSTANCE_FAMILY',
        ),
      )

      expect(response.status).toBe(200)
      expect(response.body).toEqual(expectedResponse)
      expect(mockGetRecommendations).toHaveBeenCalledWith({
        awsRecommendationTarget: 'CROSS_INSTANCE_FAMILY',
      })
    })

    it('returns data when a Same Instance Family AWS recommendation target is given', async () => {
      const expectedResponse: RecommendationResult[] = []

      mockGetRecommendations.mockResolvedValue(expectedResponse)
      const response = await request(server).get(
        encodeURI(
          '/recommendations?awsRecommendationTarget=SAME_INSTANCE_FAMILY',
        ),
      )

      expect(response.status).toBe(200)
      expect(response.body).toEqual(expectedResponse)
      expect(mockGetRecommendations).toHaveBeenCalledWith({
        awsRecommendationTarget: 'SAME_INSTANCE_FAMILY',
      })
    })

    describe('error handling', () => {
      beforeEach(() => (console.error = jest.fn()))
      afterEach(() => (console.error = originalConsoleError))

      it('returns server error if unexpected error happens', async () => {
        mockGetRecommendations.mockRejectedValueOnce(new Error('error'))
        const response = await request(server).get(
          encodeURI('/recommendations'),
        )

        expect(response.status).toBe(500)
      })

      it('returns bad request if an invalid recommendation target is given', async () => {
        mockGetRecommendations.mockRejectedValueOnce(new Error('error'))
        const response = await request(server).get(
          encodeURI(
            '/recommendations?awsRecommendationTarget=ULTRA_INSTANCE_FAMILY',
          ),
        )

        expect(response.status).toBe(400)
      })
    })
  })

  describe('/healthz', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })
    it('return 200', async () => {
      const response = await request(server).get(encodeURI('/healthz'))

      expect(response.status).toBe(200)
    })
  })
})
