import "chart.js";

declare module "chart.js" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface PluginOptionsByType<TType extends keyof ChartTypeRegistry> {
    chartRegions?: {
      cutoffEnd?: number;
      xMin?: number;
      timeoutRanges?: { start: number; end: number }[];
    };
    latencyRange?: {
      ranges?: { ts: number; min: number; max: number; color: string }[];
    };
    errorBandLabels?: {
      empty?: boolean;
      total?: number;
    };
  }
}