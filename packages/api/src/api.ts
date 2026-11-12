/*
 * © 2021 Thoughtworks, Inc.
 */

import express from 'express'
import { setConfig, CCFConfig } from '@cloud-carbon-footprint/common'
import {
  FootprintApiMiddleware,
  EmissionsApiMiddleware,
  GridIntensityCapabilitiesApiMiddleware,
  RecommendationsApiMiddleware,
} from './middleware'

export const createRouter = (config?: CCFConfig) => {
  setConfig(config)

  const router = express.Router()

  /**
   * @openapi
   * /api/footprint:
   *  get:
   *     tags:
   *     - Footprint
   *     summary: Gets calculated energy and carbon estimates for a given date range
   *     produces:
   *       - application/json
   *     parameters:
   *      - name: start
   *        in: query
   *        description: The start date for the footprint; e.g. 2022-10-18
   *        schema:
   *          type: string
   *        required: true
   *      - name: end
   *        in: query
   *        schema:
   *          type: string
   *        description: The end date for the footprint
   *        required: true
   *      - name: ignoreCache
   *        in: query
   *        schema:
   *          type: boolean
   *          default: false
   *        required: false
   *      - name: groupBy
   *        in: query
   *        schema:
   *          type: string
   *          default: day
   *        required: false
   *      - name: limit
   *        in: query
   *        schema:
   *          type: number
   *          default: 50000
   *        description: The maximum number of estimates to return (MongoDB only, ignoreCache=false)
   *        required: false
   *      - name: skip
   *        in: query
   *        schema:
   *          type: number
   *          default: 0
   *        description: The maximum number of estimates to skip over (MongoDB only, ignoreCache=false)
   *        required: false
   *      - name: cloudProviders
   *        in: query
   *        schema:
   *          type: array
   *          items:
   *            type: string
   *        description: List of Cloud Providers to include in estimates (MongoDB only, Filter)
   *        required: false
   *      - name: accounts
   *        in: query
   *        schema:
   *          type: array
   *          items:
   *            type: string
   *        description: List of accounts to include in estimates (MongoDB only, Filter)
   *        required: false
   *      - name: services
   *        in: query
   *        schema:
   *          type: array
   *          items:
   *            type: string
   *        description: List of services to include in estimates (MongoDB only, Filter)
   *        required: false
   *      - name: regions
   *        in: query
   *        schema:
   *          type: array
   *          items:
   *            type: string
   *        description: List of regions to include in estimates (MongoDB only, Filter)
   *        required: false
   *      - name: tags
   *        in: query
   *        schema:
   *          type: object
   *          additionalProperties:
   *            type: string
   *        description: List of resource tags to include in estimates (MongoDB only, Filter)
   *        required: false
   *     responses:
   *       200:
   *         description: Success
   *         content:
   *          application/json:
   *            schema:
   *                type: array
   *                items:
   *                  $ref: '#/components/schemas/FootprintResponse'
   *       400:
   *         description: Bad request
   *       416:
   *         description: Partial Data Error
   *       500:
   *         description: Internal Server Error
   */
  router.get('/footprint', FootprintApiMiddleware)

  /**
   * @openapi
   * /api/regions/emissions-factors:
   *  get:
   *     tags:
   *     - Emissions Factors
   *     description: Gets the carbon intensity (co2e/kWh) of all cloud provider regions
   *     responses:
   *       200:
   *         description: Success
   *         content:
   *           application/json:
   *            schema:
   *              type: array
   *              items:
   *                $ref: '#/components/schemas/EmissionResponse'
   */
  router.get('/regions/emissions-factors', EmissionsApiMiddleware)

  /**
   * @openapi
   * /api/recommendations:
   *  get:
   *     tags:
   *     - Recommendations
   *     description: Gets recommendations from cloud providers and their estimated carbon and energy impact
   *     parameters:
   *      - name: awsRecommendationTarget
   *        in: query
   *        description: Defines whether targeted AWS recommendations should be within the same family
   *        schema:
   *          type: string
   *          enum: [SAME_INSTANCE_FAMILY, CROSS_INSTANCE_FAMILY]
   *        required: true
   *     responses:
   *       200:
   *         description: Success
   *         content:
   *           application/json:
   *            schema:
   *              type: array
   *              items:
   *                $ref: '#/components/schemas/RecommendationsResponse'
   */
  router.get('/recommendations', RecommendationsApiMiddleware)

  /**
   * @openapi
   * /api/grid-intensity/capabilities:
   *  get:
   *     tags:
   *     - Grid Intensity
   *     description: Reports, for every region of the cloud providers whose estimates are included, the electricity grid the region is on and what each configured grid intensity source can deliver (its own zone, the best quality tier for the last 24 hours, 30 days and 12 months, the licence state, any error and the attribution text). It is the report the grid-intensity-doctor command prints. It fetches no intensity data. Each source is probed once per capability TTL to see that it can be reached, which for the neso source is one request.
   *     parameters:
   *      - name: cachedEstimates
   *        in: query
   *        schema:
   *          type: boolean
   *          default: false
   *        description: Set to true to add cachedEstimates to the report, the number of periods the estimates cache holds for each grouping and how many of them are provisional. It is left out by default because counting reads the whole estimates cache. The request fails with 500 when the cache cannot be read.
   *        required: false
   *     responses:
   *       200:
   *         description: Success
   *         content:
   *           application/json:
   *            schema:
   *              $ref: '#/components/schemas/GridIntensityCapabilitiesResponse'
   *       500:
   *         description: Internal Server Error
   */
  router.get(
    '/grid-intensity/capabilities',
    GridIntensityCapabilitiesApiMiddleware,
  )

  /**
   * @openapi
   * /api/healthz:
   *  get:
   *     tags:
   *     - Healthcheck
   *     description: Responds if the app is up and running
   *     responses:
   *       200:
   *         description: Responds "OK" if app is up and running
   */
  router.get('/healthz', (req: express.Request, res: express.Response) => {
    res.status(200).send('OK')
  })

  return router
}
