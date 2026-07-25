/** Canvas / Chart.js tokens aligned with `style.css` design system. */
export const CHART_THEME = {
  grid: "rgba(42, 46, 61, 0.55)",
  gridZero: "rgba(91, 141, 239, 0.22)",
  tick: "#9aa0b4",
  axisTitle: "#8b90a0",
  legend: "#e4e6ed",
  tooltipBg: "rgba(16, 18, 26, 0.94)",
  tooltipBorder: "rgba(55, 60, 80, 0.9)",
  tooltipTitle: "#e4e6ed",
  tooltipBody: "#c4c8d6",
  emptyBar: "#2a2e3d",
  fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
} as const;

export const chartTooltipDefaults = {
  backgroundColor: CHART_THEME.tooltipBg,
  titleColor: CHART_THEME.tooltipTitle,
  bodyColor: CHART_THEME.tooltipBody,
  borderColor: CHART_THEME.tooltipBorder,
  borderWidth: 1,
  cornerRadius: 8,
  padding: 10,
  boxPadding: 4,
  usePointStyle: true,
  titleFont: { family: CHART_THEME.fontFamily, size: 12, weight: "bold" as const },
  bodyFont: { family: CHART_THEME.fontFamily, size: 11, weight: "normal" as const },
};
