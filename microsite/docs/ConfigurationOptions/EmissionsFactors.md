---
id: emissions-factors
title: Emissions Factors
slug: /emissions-factors
sidebar_position: 5
---

## Carbon Intensity Emissions Factors

Carbon Intensity Emissions Factors are values that represent the amount of carbon dioxide equivalent (CO2e) emissions produced per unit of energy consumed. These factors vary depending on factors like energy source and geographical region. CCF utilizes these factors to estimate emissions associated with cloud infrastructure energy consumption.
We provide more detailed information in our [methodology](https://www.cloudcarbonfootprint.org/docs/methodology#carbon-estimates-co2e) on how the tool uses carbon intensity emissions factors and how the defaults are sourced.

### Default Emissions Factors

CCF comes with a set of default emissions factors that are sourced from publicly available data sources such as government agencies, energy organizations, and research institutions. These default factors provide a reasonable estimate of carbon intensity for different energy sources and regions and are used when no specific configuration is provided.
For reference, we have the default grid emissions factors located [here](https://www.cloudcarbonfootprint.org/docs/methodology#appendix-v-grid-emissions-factors) in the appendix of the Methodology.

### Electricity Maps API Configuration

CCF can be configured to use the Electricity Maps API to obtain carbon intensity factors per region across the supported cloud providers.

How the current integration behaves (this is being replaced; see `docs/design/2026-11-localised-time-resolved-carbon-estimation.md` in the repository):

- For each usage row, CCF calls the `carbon-intensity/past` endpoint with the start of the row's usage period (midnight UTC of the day, or the first day of the period for coarser groupings). That endpoint returns the intensity for a single hour, so the value applied to the whole period is the intensity of that one hour, not an average over the day or month.
- Values are memoised in memory per zone and period start for the lifetime of the process; nothing is persisted between runs.
- The cloud-region to Electricity Maps zone mapping is maintained in each provider package.
- Recommendations and lookup tables, which have no usage period of their own, use the intensity at midnight UTC at the start of the previous day.
- If a request to Electricity Maps fails (a network error, a response that is not JSON, an invalid or expired token answered with HTTP 401, or a server error, HTTP 5xx), the estimate stops with an error and nothing is written to the estimates cache, so the next run asks again. This holds for AWS, Google Cloud and Azure billing data alike; Azure used to leave out the subscription instead. Recommendations handle a failed request as before:
  - AWS recommendations fail the request.
  - Google Cloud reports zero savings, with a warning, for each recommendation it costs individually. An idle IP address recommendation in a project with other costed recommendations fails the whole recommendations request.
  - Azure Advisor leaves out the subscription's recommendations, with a warning.
- If Electricity Maps answers without a value in any other way (for example an error response for a zone the token cannot access), CCF logs a warning and uses the default emissions factor for that row. Each row makes its own request and logs its own warning, and those rows are cached like any other.

Here's how to configure CCF to use the Electricity Maps API:

1. **Obtain API Access**: First, you will need to obtain access to the Electricity Maps API. You can typically do this by signing up for an API token on the [Electricity Maps website](https://www.electricitymaps.com/get-our-data).

2. **Configuration File**: Open the CCF configuration file. This file is typically named `.env`, either located in the `api` or `cli` packages, and it is where you specify various settings for CCF. You can also refer to our [Configurations Glossary](https://www.cloudcarbonfootprint.org/docs/configurations-glossary#optionally-set-electricity-maps-api-token).

3. **API Key Configuration**: In the configuration file, create a new environment variable called `ELECTRICITY_MAPS_TOKEN`, and set your token as the value. The name must be spelled exactly as shown; the code reads `ELECTRICITY_MAPS_TOKEN`.

   ```yaml
   # Example CCF Configuration File

   # Configuration for Electricity Maps API
   ELECTRICITY_MAPS_TOKEN=your-token-here
   ```

4. **Run CCF**: Once you have configured CCF to use the Electricity Maps API, you can run the tool as you normally would. CCF will now use the Electricity Maps API to obtain carbon intensity factors for each region.

### Where each estimate's factor came from

AWS, Google Cloud and Azure service estimates computed from billing data (Cost and Usage Reports, the billing export and Consumption Management) carry a `provenance` object in the API response. It names the factor's source (`static` for the default factors, `electricitymaps-v3` when the Electricity Maps token is used) and the grid zone. It also gives the granularity, accounting basis and licence of the data, a quality tier from A (hourly data for hourly usage) to D (the static annual factors), and `gCO2ePerKWh`, the grid intensity applied to the row. A row's `kilowattHours` includes its embodied emissions converted to energy at that same factor, so for every row with a `co2e` value, `co2e` in tonnes is `kilowattHours` times `gCO2ePerKWh` divided by 1,000,000. (An AWS row whose instance type CCF cannot size has no `co2e`, an upstream limitation.)

Estimates from the cloud usage APIs (billing data turned off), rows cached before the upgrade, and Alibaba Cloud and on-premise estimates do not carry it. Provenance roughly doubles the size of each service estimate in the API response and in the estimates cache, so about half as many rows fit within the response and cache size limits.

### Additional Notes

- If you do not have access to the Electricity Maps API, you can still use CCF with the default emissions factors. Simply do not configure the tool to use the Electricity Maps API, and it will use the default factors instead.
- If Electricity Maps returns no value for a region, or the region has no Electricity Maps zone, the app falls back to the default emissions factors. A failed request stops the estimate instead (see above).
- The Electricity Maps API free tier is for non-commercial use; commercial use requires a subscription. Check the terms that apply to your deployment before configuring a token.
- For more information on the Electricity Maps API, please visit the [Electricity Maps API Documentation](https://app.electricitymaps.com/api/docs/reference).
