import type { Row } from "./upi-parser";
import { parseRows, parseText, type UpiCredit } from "./upi-parser";

async function readPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Group text items into visual lines by their y position.
    const lines = new Map<number, { x: number; s: string }[]>();
    for (const item of content.items as Array<{ str?: string; transform?: number[] }>) {
      if (!item.str || !item.transform) continue;
      const y = Math.round(item.transform[5] ?? 0);
      const x = item.transform[4] ?? 0;
      const key = Math.round(y / 3) * 3;
      const arr = lines.get(key) ?? [];
      arr.push({ x, s: item.str });
      lines.set(key, arr);
    }
    const ordered = [...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) =>
        items
          .sort((a, b) => a.x - b.x)
          .map((i) => i.s)
          .join(" "),
      );
    pages.push(ordered.join("\n"));
  }
  return pages.join("\n");
}

async function readSheetRows(file: File): Promise<Row[]> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", raw: false });
  const rows: Row[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
    for (const r of data) rows.push((r as unknown[]).map((c) => (c == null ? "" : String(c))));
  }
  return rows;
}

export async function extractFromFile(file: File): Promise<UpiCredit[]> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf")) {
    return parseText(await readPdfText(file));
  }
  if (name.endsWith(".xls") || name.endsWith(".xlsx") || name.endsWith(".csv")) {
    return parseRows(await readSheetRows(file));
  }
  return parseText(await file.text());
}
