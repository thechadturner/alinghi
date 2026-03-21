/**
 * Channel Extractor Utility
 * 
 * Extracts all required channels from chart/overlay configurations
 * to enable fetching all channels at once from the API
 */

/**
 * Extract all required channels from an overlay/chart configuration
 * @param chartConfig - The chart configuration object (chart_info[0])
 * @returns Array of unique channel names (including Datetime)
 */
export function extractRequiredChannels(chartConfig: any): string[] {
  if (!chartConfig || !chartConfig.series) {
    return ['Datetime']; // Always include Datetime
  }

  const channels = new Set<string>(['Datetime']); // Always include Datetime
  
  const series_list = chartConfig.series || [];
  const series2_list = chartConfig.series2 || [];
  
  // Extract channels from primary series
  series_list.forEach((item: any) => {
    if (item?.channel?.name) {
      channels.add(item.channel.name);
    }
  });
  
  // Extract channel2 from secondary series (for TextBox overlays)
  series2_list.forEach((item: any) => {
    if (item?.channel2?.name) {
      channels.add(item.channel2.name);
    }
  });
  
  return Array.from(channels);
}

/**
 * Extract all required channels from multiple chart configurations
 * Useful when a parent component has multiple child components
 * @param chartConfigs - Array of chart configuration objects
 * @returns Array of unique channel names (including Datetime)
 */
export function extractRequiredChannelsFromMultiple(chartConfigs: any[]): string[] {
  const allChannels = new Set<string>(['Datetime']); // Always include Datetime
  
  chartConfigs.forEach(config => {
    const channels = extractRequiredChannels(config);
    channels.forEach(ch => allChannels.add(ch));
  });
  
  return Array.from(allChannels);
}

/**
 * Extract channels from a series array
 * @param series - Array of series items
 * @returns Array of channel names
 */
export function extractChannelsFromSeries(series: any[]): string[] {
  const channels = new Set<string>();
  
  series.forEach((item: any) => {
    if (item?.channel?.name) {
      channels.add(item.channel.name);
    }
    if (item?.channel2?.name) {
      channels.add(item.channel2.name);
    }
  });
  
  return Array.from(channels);
}

