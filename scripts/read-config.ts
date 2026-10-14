import { monitorConfig } from "../monitor.config.ts";

// Emit ASCII-only JSON (\uXXXX escapes for non-ASCII) so Windows PowerShell
// 5.1, which decodes native stdout with the OEM code page, still gets valid
// JSON (a raw UTF-8 multibyte char could otherwise swallow a quote).
const json = JSON.stringify(monitorConfig).replace(
  /[\u007f-\uffff]/g,
  (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
);

process.stdout.write(json);