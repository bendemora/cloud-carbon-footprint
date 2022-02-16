/*
 * © 2021 Thoughtworks, Inc.
 */

import express from 'express'
import csv from 'csvtojson'

import { appendOrAccumulateEstimatesByDay } from '@cloud-carbon-footprint/core'

import {
  App,
  CreateValidRecommendationsRequest,
  FootprintEstimatesRawRequest,
  RecommendationsRawRequest,
} from '@cloud-carbon-footprint/app'

import {
  EstimationRequestValidationError,
  GroupBy,
  Logger,
  PartialDataError,
  RecommendationsRequestValidationError,
} from '@cloud-carbon-footprint/common'
import path from 'path'
import process from 'process'
import { GCP_EMISSIONS_FACTORS_METRIC_TON_PER_KWH } from '@cloud-carbon-footprint/gcp'

const apiLogger = new Logger('api')

/**
 * Returns the raw estimates
 *
 * Query params:
 * start - Required, UTC start date in format YYYY-MM-DD
 * end - Required, UTC start date in format YYYY-MM-DD
 */
const FootprintApiMiddleware = async function (
  req: express.Request,
  res: express.Response,
): Promise<void> {
  // Set the request time out to 10 minutes to allow the request enough time to complete.
  req.socket.setTimeout(1000 * 60 * 10)
  const rawRequest: FootprintEstimatesRawRequest = {
    startDate: req.query.start?.toString(),
    endDate: req.query.end?.toString(),
    ignoreCache: req.query.ignoreCache?.toString(),
    groupBy: req.query.groupBy?.toString(),
  }
  apiLogger.info(
    `Footprint API request started with Start Date: ${rawRequest.startDate} and End Date: ${rawRequest.endDate}`,
  )
  if (!rawRequest.groupBy)
    apiLogger.warn(
      'GroupBy parameter not specified. This will be required in the future.',
    )
  try {
    const filePath = path.join(process.cwd(), 'google-carbon-data.csv')
    const parsedCsv = await csv().fromFile(filePath)
    const csvData = JSON.parse(JSON.stringify(parsedCsv))

    const results: any[] = []

    csvData.map((row: any) => {
      row['timestamp'] = new Date(row.timestamp)
      row['cloudProvider'] = 'GCP'
      row['cost'] = 0
      const co2e = parseFloat(row.co2e)
      const footprintEstimate = {
        timestamp: row.timestamp,
        kilowattHours:
          co2e / GCP_EMISSIONS_FACTORS_METRIC_TON_PER_KWH[row.region],
        co2e: co2e,
      }
      appendOrAccumulateEstimatesByDay(
        results,
        row,
        footprintEstimate,
        GroupBy.month,
      )
    })

    res.json(results)
  } catch (e) {
    apiLogger.error(`Unable to process footprint request.`, e)
    if (
      e.constructor.name ===
      EstimationRequestValidationError.prototype.constructor.name
    ) {
      res.status(400).send(e.message)
    } else if (
      e.constructor.name === PartialDataError.prototype.constructor.name
    ) {
      res.status(416).send(e.message)
    } else res.status(500).send('Internal Server Error')
  }
}

const EmissionsApiMiddleware = async function (
  req: express.Request,
  res: express.Response,
): Promise<void> {
  apiLogger.info(`Regions emissions factors API request started`)
  const footprintApp = new App()
  try {
    const emissionsResults = await footprintApp.getEmissionsFactors()
    res.json(emissionsResults)
  } catch (e) {
    apiLogger.error(`Unable to process regions emissions factors request.`, e)
    res.status(500).send('Internal Server Error')
  }
}

const RecommendationsApiMiddleware = async function (
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const rawRequest: RecommendationsRawRequest = {
    awsRecommendationTarget: req.query.awsRecommendationTarget?.toString(),
  }
  apiLogger.info(`Recommendations API request started`)
  const footprintApp = new App()
  try {
    const estimationRequest = CreateValidRecommendationsRequest(rawRequest)
    const recommendations = await footprintApp.getRecommendations(
      estimationRequest,
    )
    res.json(recommendations)
  } catch (e) {
    apiLogger.error(`Unable to process recommendations request.`, e)
    if (
      e.constructor.name ===
      RecommendationsRequestValidationError.prototype.constructor.name
    ) {
      res.status(400).send(e.message)
    } else {
      res.status(500).send('Internal Server Error')
    }
  }
}

const router = express.Router()

router.get('/footprint', FootprintApiMiddleware)
router.get('/regions/emissions-factors', EmissionsApiMiddleware)
router.get('/recommendations', RecommendationsApiMiddleware)
router.get('/healthz', (req: express.Request, res: express.Response) => {
  res.status(200).send('OK')
})
export default router
