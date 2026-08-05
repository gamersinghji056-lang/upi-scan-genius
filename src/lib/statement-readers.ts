import { ocrStatementPages } from "./ocr.functions";
import type { ExtractResult, Row } from "./upi-parser";
import { mergeResults, parseRowsDetailed, parseTextDetailed } from "./upi-parser";


async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  return pdfjs;
}


async function pdfText(doc: any): Promise<{ text: string; sparsePages: number[] }> {
  const pages: string[] = [];
  const sparsePages: number[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
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
    const pageText = ordered.join("\n");
    // A text layer with almost no characters means the page is a scan.
    if (pageText.replace(/\s/g, "").length < 120) sparsePages.push(p);
    pages.push(pageText);
  }

  return { text: pages.join("\n"), sparsePages };
}

async function pageToDataUrl(doc: any, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(viewport.width, 2200);
  canvas.height = Math.round((canvas.width / viewport.width) * viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not render this PDF page.");
  const scaled = page.getViewport({ scale: (canvas.width / viewport.width) * 2 });
  await page.render({ canvasContext: ctx, viewport: scaled, canvas }).promise;
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

async function ocr(images: string[]): Promise<string> {
  const { text } = await ocrStatementPages({ data: { images } });
  return text;
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

export type ExtractProgress = (stage: string) => void;

export async function extractFromFile(
  file: File,
  onProgress?: ExtractProgress,
): Promise<UpiCredit[]> {
  const name = file.name.toLowerCase();
  const isImage =
    file.type.startsWith("image/") || /\.(jpg|jpeg|png|webp|bmp|tiff?)$/.test(name);

  if (isImage) {
    onProgress?.("Reading scanned image…");
    return parseText(await ocr([await fileToDataUrl(file)]));
  }

  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    onProgress?.("Reading PDF…");
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const { text, sparsePages } = await pdfText(doc);

    let combined = text;
    if (sparsePages.length) {
      onProgress?.(`Running OCR on ${sparsePages.length} scanned page(s)…`);
      const images: string[] = [];
      for (const p of sparsePages.slice(0, 12)) images.push(await pageToDataUrl(doc, p));
      combined = `${combined}\n${await ocr(images)}`;
    }
    return parseText(combined);
  }

  if (name.endsWith(".xls") || name.endsWith(".xlsx") || name.endsWith(".csv")) {
    onProgress?.("Reading spreadsheet…");
    return parseRows(await readSheetRows(file));
  }

  onProgress?.("Reading text…");
  return parseText(await file.text());
}
