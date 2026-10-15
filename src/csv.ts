export type CsvRow = Record<string, string>;

/**
 * Minimal CSV reader. Our generated files never contain quoted commas or newlines,
 * so a plain split is enough. Do not reuse this for free-text exports.
 */
export function parseCsv(text: string): CsvRow[] {
  const lines = text.trimEnd().split("\n");
  const headers = (lines.shift() ?? "").split(",");
  return lines.map((line) => {
    const values = line.split(",");
    const row: CsvRow = {};
    headers.forEach((header, i) => {
      row[header] = values[i] ?? "";
    });
    return row;
  });
}
