/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { GroupBy, Provenance } from '@cloud-carbon-footprint/common'
import BillingDataRow from '../BillingDataRow'
import {
  appendOrAccumulateEstimatesByDay,
  MutableEstimationResult,
} from '../FootprintEstimate'
import { mergeProvenance } from '../provenance'

const staticProvenance: Provenance = {
  sourceId: 'static',
  zoneId: 'aws:eu-west-2',
  granularity: 'year',
  basis: 'location-production',
  factorType: 'direct',
  isEstimated: false,
  licenceId: 'open-attribution',
  qualityTier: 'D',
  gCO2ePerKWh: 305,
  modelVersion: 'unversioned',
}

const liveProvenance: Provenance = {
  sourceId: 'electricitymaps-v3',
  zoneId: 'GB',
  granularity: 'hour',
  basis: 'location-consumption',
  factorType: 'lifecycle',
  isEstimated: false,
  licenceId: 'custom',
  qualityTier: 'B',
  gCO2ePerKWh: 200,
  modelVersion: 'unversioned',
}

describe('mergeProvenance', () => {
  it('is absent when neither row has provenance', () => {
    expect(mergeProvenance(undefined, 1, undefined, 1)).toBeUndefined()
  })

  it('keeps identical provenance as it is', () => {
    expect(
      mergeProvenance(staticProvenance, 1, { ...staticProvenance }, 2),
    ).toEqual(staticProvenance)
  })

  it('keeps the lower tier, marks it estimated and weights the intensity by energy', () => {
    expect(mergeProvenance(liveProvenance, 3, staticProvenance, 1)).toEqual({
      ...staticProvenance,
      isEstimated: true,
      // (200 * 3 + 305 * 1) / 4
      gCO2ePerKWh: 226.25,
    })
  })

  it('drops a tier A or B row to C when it has to be marked estimated', () => {
    const hourly: Provenance = {
      ...liveProvenance,
      qualityTier: 'A',
      gCO2ePerKWh: 100,
    }
    expect(mergeProvenance(hourly, 1, liveProvenance, 1)).toEqual({
      ...liveProvenance,
      isEstimated: true,
      qualityTier: 'C',
      gCO2ePerKWh: 150,
    })
  })

  it('averages the intensities when neither row has energy', () => {
    expect(
      mergeProvenance(liveProvenance, 0, staticProvenance, 0)?.gCO2ePerKWh,
    ).toBe(252.5)
  })

  it('keeps the provenance it has, marked estimated, when the other row has none', () => {
    expect(mergeProvenance(undefined, 1, liveProvenance, 1)).toEqual({
      ...liveProvenance,
      isEstimated: true,
      qualityTier: 'C',
    })
    expect(mergeProvenance(staticProvenance, 1, undefined, 1)).toEqual({
      ...staticProvenance,
      isEstimated: true,
    })
  })

  it('treats a different calibration version as different provenance', () => {
    const calibrated = { ...staticProvenance, calibrationVersion: '2026.1' }
    expect(
      mergeProvenance(staticProvenance, 1, calibrated, 1)?.isEstimated,
    ).toBe(true)
  })
})

describe('appendOrAccumulateEstimatesByDay with provenance', () => {
  const day = new Date('2026-03-10T00:00:00.000Z')
  const row: BillingDataRow = {
    timestamp: day,
    accountId: 'account',
    accountName: 'Account',
    region: 'eu-west-2',
    usageType: 'BoxUsage:m5.large',
    usageUnit: 'Hrs',
    vCpus: 2,
    machineType: undefined,
    seriesName: undefined,
    serviceName: 'AmazonEC2',
    usageAmount: 1,
    cost: 1,
    cloudProvider: 'AWS',
    vCpuHours: 2,
    instanceType: 'm5.large',
    replicationFactor: 1,
    tags: {},
  }

  it('copies the provenance onto a new row', () => {
    const results: MutableEstimationResult[] = []
    appendOrAccumulateEstimatesByDay(
      results,
      row,
      {
        timestamp: day,
        kilowattHours: 2,
        co2e: 1,
        provenance: staticProvenance,
      },
      GroupBy.day,
      [],
    )
    expect(results[0].serviceEstimates[0].provenance).toEqual(staticProvenance)
  })

  it('adds no provenance property when the estimate has none', () => {
    const results: MutableEstimationResult[] = []
    appendOrAccumulateEstimatesByDay(
      results,
      row,
      { timestamp: day, kilowattHours: 2, co2e: 1 },
      GroupBy.day,
      [],
    )
    expect(Object.keys(results[0].serviceEstimates[0])).not.toContain(
      'provenance',
    )
  })

  it('merges the provenance of rows accumulated into one, weighting by energy before adding', () => {
    const results: MutableEstimationResult[] = []
    appendOrAccumulateEstimatesByDay(
      results,
      row,
      {
        timestamp: day,
        kilowattHours: 3,
        co2e: 0.6,
        provenance: liveProvenance,
      },
      GroupBy.day,
      [],
    )
    appendOrAccumulateEstimatesByDay(
      results,
      row,
      {
        timestamp: day,
        kilowattHours: 1,
        co2e: 0.305,
        provenance: staticProvenance,
      },
      GroupBy.day,
      [],
    )
    expect(results[0].serviceEstimates).toHaveLength(1)
    expect(results[0].serviceEstimates[0].kilowattHours).toBe(4)
    expect(results[0].serviceEstimates[0].provenance).toEqual({
      ...staticProvenance,
      isEstimated: true,
      gCO2ePerKWh: 226.25,
    })
  })

  it('leaves accumulated rows without provenance without a provenance property', () => {
    const results: MutableEstimationResult[] = []
    for (let i = 0; i < 2; i++)
      appendOrAccumulateEstimatesByDay(
        results,
        row,
        { timestamp: day, kilowattHours: 1, co2e: 1 },
        GroupBy.day,
        [],
      )
    expect(Object.keys(results[0].serviceEstimates[0])).not.toContain(
      'provenance',
    )
  })
})
