/**
 * Parse target filename to extract configuration components.
 * Format: {prefix}_{name}_{wingCode}_{dbCode}_{rudCode}.kph
 * Example: 2411_m2_APW_LAB_LARW.kph
 */
import { debug, error as logError } from "./console";

export interface ParsedTargetFilename {
  name: string;
  wingCode: string;
  dbCode: string;
  rudCode: string;
}

export function parseTargetFilename(filename: string): ParsedTargetFilename | null {
  try {
    const nameWithoutExt = filename.replace(/\.kph$/i, "");
    const parts = nameWithoutExt.split("_");
    if (parts.length < 5) {
      debug("[targetConfig] Target filename does not have enough segments:", filename, "parts:", parts.length);
      return null;
    }
    const parsed: ParsedTargetFilename = {
      name: (parts[1] || "").toUpperCase(),
      wingCode: parts[2] || "",
      dbCode: parts[3] || "",
      rudCode: (parts[4] || "").replace(/\.kph$/i, ""),
    };
    if (!parsed.name || !parsed.wingCode || !parsed.dbCode || !parsed.rudCode) {
      debug("[targetConfig] Target filename missing required segments:", filename, "parsed:", parsed);
      return null;
    }
    debug("[targetConfig] Parsed target filename:", filename, "result:", parsed);
    return parsed;
  } catch (err: unknown) {
    logError("[targetConfig] Error parsing target filename:", filename, err);
    return null;
  }
}
