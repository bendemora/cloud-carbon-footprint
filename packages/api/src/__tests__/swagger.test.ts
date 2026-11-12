/*
 * © 2021 Thoughtworks, Inc.
 */

import { Logger } from '@cloud-carbon-footprint/common'
import request from 'supertest'
import express from 'express'
import swaggerDocs from '../utils/swagger'

describe('swaggerDocs', () => {
  const server = express()
  const port = 3000

  beforeAll(() => {
    swaggerDocs(server, port)
  })

  it('should return the Swagger UI page', async () => {
    const res = await request(server).get(encodeURI('/docs')).redirects(1)
    expect(res.status).toEqual(200)
    expect(res.text).toContain('Swagger UI')
  })

  it('should return the Swagger JSON file', async () => {
    const res = await request(server).get('/docs.json')
    expect(res.status).toEqual(200)
    expect(res.body).toHaveProperty('openapi')
    expect(res.body.openapi).toEqual('3.0.0')
    expect(res.body).toHaveProperty('info')
    expect(res.body.info).toHaveProperty('title')
    expect(res.body.info.title).toEqual('CCF API Docs')
    expect(res.body.info).toHaveProperty('version')
    expect(res.body.info.version).toEqual('1.6.0')
  })

  it('should document the grid intensity capabilities endpoint and its response', async () => {
    const res = await request(server).get('/docs.json')
    const operation = res.body.paths['/api/grid-intensity/capabilities'].get
    expect(
      operation.responses['200'].content['application/json'].schema,
    ).toEqual({
      $ref: '#/components/schemas/GridIntensityCapabilitiesResponse',
    })
    const schema = res.body.components.schemas.GridIntensityCapabilitiesResponse
    expect(schema.required).toEqual(['generatedAt', 'regions'])
    expect(
      schema.properties.regions.items.properties.sources.items.properties
        .bestTier.properties.last12Months.enum,
    ).toEqual(['A', 'B', 'C', 'D', null])
  })

  it('should document the cachedEstimates parameter of the capabilities endpoint and what it adds to the response', async () => {
    const res = await request(server).get('/docs.json')
    const operation = res.body.paths['/api/grid-intensity/capabilities'].get
    expect(operation.parameters).toEqual([
      {
        name: 'cachedEstimates',
        in: 'query',
        schema: { type: 'boolean', default: false },
        description: expect.stringContaining(
          'counting reads the whole estimates cache',
        ),
        required: false,
      },
    ])
    const { cachedEstimates } =
      res.body.components.schemas.GridIntensityCapabilitiesResponse.properties
    expect(cachedEstimates.type).toBe('array')
    expect(cachedEstimates.description).toContain('cachedEstimates=true')
    expect(cachedEstimates.items.required).toEqual([
      'groupBy',
      'cachedPeriods',
      'provisionalPeriods',
    ])
    expect(cachedEstimates.items.properties.groupBy.enum).toEqual([
      'day',
      'week',
      'month',
      'quarter',
      'year',
    ])
    // The field is optional: only generatedAt and regions are always there.
    expect(
      res.body.components.schemas.GridIntensityCapabilitiesResponse.required,
    ).toEqual(['generatedAt', 'regions'])
  })

  it('should log the availability of the docs', () => {
    const spy = jest.spyOn(Logger.prototype, 'info')
    swaggerDocs(server, port)
    expect(spy).toHaveBeenCalledWith(
      `Documentation available at http://localhost:${port}/docs`,
    )
  })
})
