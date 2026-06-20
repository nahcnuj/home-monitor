import "chart.js";

declare module "chart.js" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface PluginOptionsByType<TType extends keyof ChartTypeRegistry> {
    chartRegions?: {
      cutoffEnd?: number;
      xMin?: number;
      timeoutRanges?: { start: number; end: number }[];
    };
    violinPlot?: {
      series?: import("./types.ts").ViolinSeries[];
    };
    errorBandLabels?: {
      empty?: boolean;
      total?: number;
    };
  }
}