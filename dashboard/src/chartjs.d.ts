import "chart.js";

declare module "chart.js" {
  interface TooltipPositionerMap {
    errorBarBelow: TooltipPositioner;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface PluginOptionsByType<TType extends keyof ChartTypeRegistry> {
    chartRegions?: {
      cutoffEnd?: number;
      xMin?: number;
      timeoutRanges?: { start: number; end: number }[];
    };
    errorBandLabels?: {
      empty?: boolean;
      total?: number;
    };
  }
}