export type CsvRow = Record<string, string>;

function detectDelimiter(line: string) {
  return [",", ";", "\t"].map((delimiter) => ({ delimiter, count: line.split(delimiter).length })).sort((a, b) => b.count - a.count)[0].delimiter;
}

function parseLine(line: string, delimiter: string) {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

export function parseCsv(input: string) {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n").filter((line) => line.trim());
  if (lines.length < 2) throw new Error("Le fichier CSV est vide");
  const delimiter = detectDelimiter(lines[0]);
  const headers = parseLine(lines[0], delimiter);
  return lines.slice(1).map((line) => {
    const values = parseLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

export async function readCsvFile(file: File) {
  if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Utilise un export CSV Screaming Frog pour cette version");
  return parseCsv(await file.text());
}
