import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Loader2, Download, FileText, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { extractFromFile } from "@/lib/statement-readers";
import {
  mergeResults,
  parseTextDetailed,
  toCsv,
  type ExtractDebug,
  type UpiCredit,
} from "@/lib/upi-parser";


export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "UPI Credit Extractor — Indian Bank Statement Parser" },
      {
        name: "description",
        content:
          "Extract UPI credit transactions (Date, UTR, Amount, Mode) from any Indian bank statement PDF, CSV, Excel or text file. Bank-independent parsing, entirely in your browser.",
      },
      { property: "og:title", content: "UPI Credit Extractor — Indian Bank Statement Parser" },
      {
        property: "og:description",
        content:
          "Bank-independent extraction of UPI credit transactions from statement PDFs, spreadsheets and text — Date, UTR, Amount, Mode.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

function Index() {
  const [rows, setRows] = useState<UpiCredit[] | null>(null);
  const [debug, setDebug] = useState<ExtractDebug | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Developer mode only: dev server, or ?debug=1 on the URL.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("debug");
    setDevMode(import.meta.env.DEV || q === "1" || q === "true");
  }, []);

  const runFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setBusy(true);
    setError(null);
    try {
      const parts = [];
      for (const f of list) parts.push(await extractFromFile(f, setStage));
      const merged = mergeResults(parts);
      setRows(merged.rows);
      setDebug(merged.debug);
      setSourceName(list.map((f) => f.name).join(", "));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
      setRows(null);
      setDebug(null);
    } finally {
      setBusy(false);
      setStage(null);
    }
  }, []);

  const runText = () => {
    setError(null);
    setSourceName("Pasted statement text");
    const result = parseTextDetailed(pasted);
    setRows(result.rows);
    setDebug(result.debug);
  };


  const download = () => {
    if (!rows) return;
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "upi-credits.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const total = rows?.reduce((s, r) => s + Number(r.amount), 0) ?? 0;

  return (
    <main className="min-h-screen">
      <header className="bg-header-gradient px-5 py-10 text-primary-foreground sm:px-8 sm:py-14">
        <div className="mx-auto max-w-5xl">
          <p className="text-xs font-medium tracking-[0.2em] uppercase opacity-75">
            Universal statement engine
          </p>
          <h1 className="mt-3 text-3xl leading-tight font-semibold sm:text-4xl">
            UPI Credit Extraction
          </h1>
          <p className="mt-3 max-w-xl text-sm opacity-85 sm:text-base">
            Drop any Indian bank statement — text PDF, scanned PDF, photo, CSV, XLS, XLSX or plain text. Only genuine UPI
            credit transactions are returned: Date, UTR, Amount, Mode. No bank selection, template or mapping needed.
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-6 px-5 py-8 sm:px-8">
        <section
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void runFiles(e.dataTransfer.files);
          }}
          className={`rounded-xl border-2 border-dashed bg-card p-8 text-center transition-colors ${
            dragging ? "border-primary bg-accent/40" : "border-border"
          }`}
        >
          <FileUp className="mx-auto h-8 w-8 text-primary" aria-hidden />
          <p className="mt-3 text-sm font-medium">Drag a statement here, or</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.csv,.xls,.xlsx,.txt,.text,.jpg,.jpeg,.png,.webp,image/*"
            className="hidden"
            onChange={(e) => e.target.files && void runFiles(e.target.files)}
          />
          <Button className="mt-4" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {busy ? (stage ?? "Parsing…") : "Choose file"}
          </Button>
          <p className="mt-3 text-xs text-muted-foreground">PDF (text or scanned) · CSV · XLS · XLSX · TXT · JPG · PNG · WEBP</p>
        </section>

        <section className="rounded-xl border bg-card p-5 shadow-card">
          <h2 className="text-sm font-semibold">Or paste statement text</h2>
          <Textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={5}
            placeholder="12/12/2025  UPI/426272626736/RAHUL/HDFC  CR  324.00  10,450.00"
            className="mt-3 font-mono text-xs"
          />
          <div className="mt-3 flex gap-2">
            <Button onClick={runText} disabled={!pasted.trim()}>
              Extract
            </Button>
            {pasted ? (
              <Button variant="ghost" onClick={() => setPasted("")}>
                <X className="mr-1 h-4 w-4" />
                Clear
              </Button>
            ) : null}
          </div>
        </section>

        {error ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {rows ? (
          <section className="overflow-hidden rounded-xl border bg-card shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-surface-ledger px-5 py-4">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <FileText className="h-4 w-4 text-primary" aria-hidden />
                  {rows.length} UPI credit{rows.length === 1 ? "" : "s"}
                </h2>
                <p className="truncate text-xs text-muted-foreground">{sourceName}</p>
              </div>
              <div className="flex items-center gap-4">
                <span className="font-mono text-sm font-semibold">
                  ₹{total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                </span>
                <Button variant="secondary" size="sm" onClick={download} disabled={!rows.length}>
                  <Download className="mr-1 h-4 w-4" />
                  CSV
                </Button>
              </div>
            </div>

            {rows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs tracking-wide text-muted-foreground uppercase">
                      <th className="px-5 py-3 font-medium">Date</th>
                      <th className="px-5 py-3 font-medium">UTR</th>
                      <th className="px-5 py-3 text-right font-medium">Amount</th>
                      <th className="px-5 py-3 font-medium">Mode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.utr}-${i}`} className="border-b last:border-0 hover:bg-muted/60">
                        <td className="px-5 py-3 font-mono whitespace-nowrap">{r.date}</td>
                        <td className="px-5 py-3 font-mono">{r.utr}</td>
                        <td className="px-5 py-3 text-right font-mono">{r.amount}</td>
                        <td className="px-5 py-3">{r.mode}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                No rows matched all four conditions (date, UPI keyword, 12-digit UTR, credit
                amount).
              </p>
            )}
          </section>
        ) : null}
      </div>
    </main>
  );
}
