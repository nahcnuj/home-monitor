import "chart.js";

declare module "chart.js" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface PluginOptionsByType<TType extends keyof ChartTypeRegistry> {
    chartRegions?: {
      timestamps?: number[];
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