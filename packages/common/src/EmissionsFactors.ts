/*
 * © 2023 Thoughtworks, Inc.
 */

import { CloudConstantsEmissionsFactors } from '@cloud-carbon-footprint/core'
import { configLoader, Logger } from './index'
import { convertGramsToMetricTons } from './helpers'

export type mappedRegionsToElectricityMapZones = {
  [key: string]: string | null
}
export const zoneIntensityFactors: {
  [key: string]: { [key: string]: number }
} = {}

export const getEmissionsFactors = async (
  region: string,
  dateTime: string,
  emissionsFactors: CloudConstantsEmissionsFactors,
  mappedRegionsToElectricityMapZones: mappedRegionsToElectricityMapZones,
  logger: Logger,
): Promise<CloudConstantsEmissionsFactors> => {
  const electricityMapsToken = configLoader().ELECTRICITY_MAPS_TOKEN

  const electricityMapsZone: string = mappedRegionsToElectricityMapZones[region]

  // if there is no zone for the region, or no token, return the default emissions factor
  if (!electricityMapsToken || !electricityMapsZone) {
    if (electricityMapsToken && !electricityMapsZone) {
      logger.warn(
        `Electricity Maps zone not found for ${region}. Using default emissions factors.`,
      )
    }
    return emissionsFactors
  }

  // if there is a cached value for the zone, return it
  if (zoneIntensityFactors[dateTime]?.[electricityMapsZone]) {
    return {
      [region]: zoneIntensityFactors[dateTime][electricityMapsZone],
    }
  }

  // if there is no cached value for the zone, make a request to electricity maps
  let response
  try {
    response = await getElectricityMapsData(electricityMapsZone, dateTime)
  } catch (e) {
    throw new Error(
      `Failed to get data from Electricity Maps. Reason ${e.message}.`,
    )
  }

  // if there is no response, return the default emissions factor
  if (!response?.carbonIntensity) {
    // add a warning if there is no response
    logger.warn(
      `Electricity Maps zone data was not found for ${region}. Using default emissions factors.`,
    )

    return emissionsFactors
  }

  // cache the value for the zone
  if (zoneIntensityFactors[dateTime]) {
    // if there is a cached value for the date, add the new zone
    zoneIntensityFactors[dateTime][electricityMapsZone] =
      convertGramsToMetricTons(response.carbonIntensity)
  } else {
    // if there is no cached value for the date, create a new entry
    zoneIntensityFactors[dateTime] = {
      [electricityMapsZone]: convertGramsToMetricTons(response.carbonIntensity),
    }
  }

  return {
    [region]: zoneIntensityFactors[dateTime][electricityMapsZone],
  }
}

/**
 * Whether a 401 body is Electricity Maps refusing this zone or endpoint for a
 * valid token ("Request unauthorized for zoneKey=GB,..."), rather than
 * rejecting the token ("Invalid auth-token").
 */
const isZoneAccessDenial = (body: string): boolean => {
  try {
    const error = JSON.parse(body)?.error
    return (
      typeof error === 'string' &&
      error.startsWith('Request unauthorized for zoneKey=')
    )
  } catch {
    return false
  }
}

export const getElectricityMapsData = async (
  electricityMapsZone: string,
  dateTime: string,
): Promise<any> => {
  try {
    const url = `https://api.electricitymap.org/v3/carbon-intensity/past?zone=${electricityMapsZone}&datetime=${dateTime}`
    const res = await fetch(url, {
      headers: {
        'auth-token': configLoader().ELECTRICITY_MAPS_TOKEN,
      },
    })
    // An invalid token, or a server error, would be answered the same way
    // for every zone and date: fail rather than fall back to the default
    // factors row by row. A 401 that names the zone (a valid token without
    // access to this zone or endpoint) and other answers without a value
    // still fall back for that zone.
    if (res.status === 401 || res.status >= 500) {
      const text = await res.text()
      if (res.status === 401 && isZoneAccessDenial(text))
        return JSON.parse(text)
      const body = text.slice(0, 200)
      throw new Error(
        `Electricity Maps answered HTTP ${res.status}${body ? `: ${body}` : ''}`,
      )
    }
    return await res.json()
  } catch (e) {
    throw new Error(`Electricity Maps request failed. Reason: ${e.message}.`)
  }
}
