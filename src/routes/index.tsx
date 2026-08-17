import { createFileRoute } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  Download,
  FileText,
  FileUp,
  Loader2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import {
  extractFromFile,
  mergeCombined,
} from "@/lib/statement-readers";

import {
  debitBreakdown,
  parseDebitsFromText,
  timestampName,
  toDebitCsv,
  type DebitTxn,
} from "@/lib/debit-parser";

import {
  parseTextDetailed,
  toCsv,
  type ExtractDebug,
  type UpiCredit,
} from "@/lib/upi-parser";

export const Route = createFileRoute("/")({
  component: Index,

  head: () => ({
    meta: [
      {
        title:
          "Bank Statement Credit & Debit Extractor",
      },

      {
        name: "description",

        content:
          "Extract UPI credits and UPI, IMPS, NEFT and RTGS debits from Indian bank statement PDF, CSV, XLS, XLSX and TXT files.",
      },

      {
        property: "og:title",

        content:
          "Universal Indian Bank Statement Parser",
      },

      {
        property: "og:description",

        content:
          "Extract Credit and Debit transactions with Date, UTR, Amount and Mode.",
      },

      {
        property: "og:type",
        content: "website",
      },

      {
        name: "twitter:card",
        content: "summary_large_image",
      },
    ],
  }),
});

function Index() {
  const [credits, setCredits] =
    useState<UpiCredit[] | null>(
      null,
    );

  const [debits, setDebits] =
    useState<DebitTxn[] | null>(
      null,
    );

  const [tab, setTab] =
    useState<
      "credit" | "debit"
    >("credit");

  const [debug, setDebug] =
    useState<ExtractDebug | null>(
      null,
    );

  const [busy, setBusy] =
    useState(false);

  const [error, setError] =
    useState<string | null>(
      null,
    );

  const [
    sourceName,
    setSourceName,
  ] =
    useState<string | null>(
      null,
    );

  const [pasted, setPasted] =
    useState("");

  const [
    dragging,
    setDragging,
  ] =
    useState(false);

  const [stage, setStage] =
    useState<string | null>(
      null,
    );

  const [
    devMode,
    setDevMode,
  ] =
    useState(false);

  const [
    showDebug,
    setShowDebug,
  ] =
    useState(false);

  const inputRef =
    useRef<HTMLInputElement>(
      null,
    );

  /* -------------------------------------------------------------- *
   * Developer debug mode
   * -------------------------------------------------------------- */

  useEffect(() => {
    const params =
      new URLSearchParams(
        window.location.search,
      );

    const debugValue =
      params.get("debug");

    setDevMode(
      import.meta.env.DEV ||
        debugValue === "1" ||
        debugValue === "true",
    );
  }, []);

  /* -------------------------------------------------------------- *
   * Reset results
   * -------------------------------------------------------------- */

  const clearResults = () => {
    setCredits(null);
    setDebits(null);
    setDebug(null);
    setSourceName(null);
    setError(null);
    setTab("credit");
  };

  /* -------------------------------------------------------------- *
   * FILE EXTRACTION
   * -------------------------------------------------------------- */

  const runFiles =
    useCallback(
      async (
        files:
          | FileList
          | File[],
      ) => {
        const list =
          Array.from(files);

        if (!list.length) {
          return;
        }

        setBusy(true);

        setError(null);

        setStage(
          "Preparing statement…",
        );

        try {
          const results = [];

          for (
            const file of list
          ) {
            results.push(
              await extractFromFile(
                file,
                setStage,
              ),
            );
          }

          const merged =
            mergeCombined(
              results,
            );

          setCredits(
            merged.credit.rows,
          );

          setDebits(
            merged.debit.rows,
          );

          setDebug(
            merged.credit.debug,
          );

          setSourceName(
            list
              .map(
                (file) =>
                  file.name,
              )
              .join(", "),
          );

          /*
           * Prefer Credit initially if available.
           * Otherwise open Debit automatically.
           */
          if (
            merged.credit.rows
              .length === 0 &&
            merged.debit.rows
              .length > 0
          ) {
            setTab("debit");
          } else {
            setTab("credit");
          }
        } catch (err) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not read this statement.",
          );

          setCredits(null);
          setDebits(null);
          setDebug(null);
        } finally {
          setBusy(false);
          setStage(null);
        }
      },
      [],
    );

  /* -------------------------------------------------------------- *
   * TEXT EXTRACTION
   * -------------------------------------------------------------- */

  const runText = () => {
    if (
      !pasted.trim()
    ) {
      return;
    }

    setError(null);

    setSourceName(
      "Pasted statement text",
    );

    const creditResult =
      parseTextDetailed(
        pasted,
      );

    const debitResult =
      parseDebitsFromText(
        pasted,
      );

    setCredits(
      creditResult.rows,
    );

    setDebits(
      debitResult.rows,
    );

    setDebug(
      creditResult.debug,
    );

    if (
      creditResult.rows
        .length === 0 &&
      debitResult.rows
        .length > 0
    ) {
      setTab("debit");
    } else {
      setTab("credit");
    }
  };

  /* -------------------------------------------------------------- *
   * CSV DOWNLOAD
   * -------------------------------------------------------------- */

  const downloadCsv = () => {
    const isCredit =
      tab === "credit";

    const data =
      isCredit
        ? credits
        : debits;

    if (
      !data ||
      !data.length
    ) {
      return;
    }

    const csv =
      isCredit
        ? toCsv(
            data as UpiCredit[],
          )
        : toDebitCsv(
            data as DebitTxn[],
          );

    const blob =
      new Blob(
        [csv],
        {
          type:
            "text/csv;charset=utf-8",
        },
      );

    const url =
      URL.createObjectURL(
        blob,
      );

    const anchor =
      document.createElement(
        "a",
      );

    anchor.href = url;

    anchor.download =
      timestampName(
        isCredit
          ? "UPI_Credit_Report"
          : "Debit_Report",
      );

    document.body.appendChild(
      anchor,
    );

    anchor.click();

    anchor.remove();

    URL.revokeObjectURL(
      url,
    );
  };

  /* -------------------------------------------------------------- *
   * SUMMARY
   * -------------------------------------------------------------- */

  const creditTotal =
    credits?.reduce(
      (
        total,
        row,
      ) =>
        total +
        Number(
          row.amount,
        ),
      0,
    ) ?? 0;

  const debitTotal =
    debits?.reduce(
      (
        total,
        row,
      ) =>
        total +
        Number(
          row.amount,
        ),
      0,
    ) ?? 0;

  const difference =
    Math.abs(
      creditTotal -
        debitTotal,
    );

  const money = (
    value: number,
  ) =>
    `₹${value.toLocaleString(
      "en-IN",
      {
        minimumFractionDigits:
          2,

        maximumFractionDigits:
          2,
      },
    )}`;

  const breakdown =
    debits
      ? debitBreakdown(
          debits,
        )
      : [];

  const hasResults =
    credits !== null ||
    debits !== null;

  const visibleRows =
    tab === "credit"
      ? credits ?? []
      : debits ?? [];

  /* -------------------------------------------------------------- *
   * UI
   * -------------------------------------------------------------- */

  return (
    <main className="min-h-screen">
      <header className="bg-header-gradient px-5 py-10 text-primary-foreground sm:px-8 sm:py-14">
        <div className="mx-auto max-w-5xl">
          <p className="text-xs font-medium tracking-[0.2em] uppercase opacity-75">
            Universal Bank
            Statement Engine
          </p>

          <h1 className="mt-3 text-3xl leading-tight font-semibold sm:text-4xl">
            Credit & Debit
            Extraction
          </h1>

          <p className="mt-3 max-w-2xl text-sm opacity-85 sm:text-base">
            Upload an Indian
            bank statement and
            automatically extract
            UPI Credits and UPI,
            IMPS, NEFT and RTGS
            Debits with Date,
            UTR / Reference,
            Amount and Mode.
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-6 px-5 py-8 sm:px-8">
        {/* FILE UPLOAD */}

        <section
          onDragOver={(
            event,
          ) => {
            event.preventDefault();

            setDragging(
              true,
            );
          }}
          onDragLeave={() =>
            setDragging(
              false,
            )
          }
          onDrop={(
            event,
          ) => {
            event.preventDefault();

            setDragging(
              false,
            );

            void runFiles(
              event.dataTransfer
                .files,
            );
          }}
          className={`rounded-xl border-2 border-dashed bg-card p-8 text-center transition-colors ${
            dragging
              ? "border-primary bg-accent/40"
              : "border-border"
          }`}
        >
          <FileUp
            className="mx-auto h-8 w-8 text-primary"
            aria-hidden
          />

          <p className="mt-3 text-sm font-medium">
            Drag statement
            here, or choose a
            file
          </p>

          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.csv,.xls,.xlsx,.txt,.text,.jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff,image/*"
            className="hidden"
            onChange={(
              event,
            ) => {
              if (
                event.target
                  .files
              ) {
                void runFiles(
                  event.target
                    .files,
                );
              }
            }}
          />

          <Button
            className="mt-4"
            disabled={busy}
            onClick={() =>
              inputRef.current?.click()
            }
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}

            {busy
              ? stage ??
                "Parsing…"
              : "Choose file"}
          </Button>

          <p className="mt-3 text-xs text-muted-foreground">
            PDF · CSV · XLS ·
            XLSX · TXT · JPG ·
            PNG · WEBP
          </p>
        </section>

        {/* PASTE TEXT */}

        <section className="rounded-xl border bg-card p-5 shadow-card">
          <h2 className="text-sm font-semibold">
            Or paste statement
            text
          </h2>

          <Textarea
            value={pasted}
            onChange={(
              event,
            ) =>
              setPasted(
                event.target
                  .value,
              )
            }
            rows={6}
            placeholder="12/12/2025  UPI/426272626736/CR/RAHUL/HDFC  Cr  324.00  10,450.00"
            className="mt-3 font-mono text-xs"
          />

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              onClick={
                runText
              }
              disabled={
                !pasted.trim()
              }
            >
              Extract
            </Button>

            {pasted ? (
              <Button
                variant="ghost"
                onClick={() =>
                  setPasted("")
                }
              >
                <X className="mr-1 h-4 w-4" />

                Clear text
              </Button>
            ) : null}

            {hasResults ? (
              <Button
                variant="ghost"
                onClick={
                  clearResults
                }
              >
                Clear results
              </Button>
            ) : null}
          </div>
        </section>

        {/* ERROR */}

        {error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {/* SUMMARY */}

        {hasResults ? (
          <section className="rounded-xl border bg-card p-5 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">
                  Statement
                  Summary
                </h2>

                {sourceName ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {
                      sourceName
                    }
                  </p>
                ) : null}
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <SummaryItem
                label="UPI Credit Volume"
                value={money(
                  creditTotal,
                )}
              />

              <SummaryItem
                label="Debit Volume"
                value={money(
                  debitTotal,
                )}
              />

              <SummaryItem
                label="Difference"
                value={money(
                  difference,
                )}
              />

              <SummaryItem
                label="Credit Transactions"
                value={String(
                  credits
                    ?.length ??
                    0,
                )}
              />

              <SummaryItem
                label="Debit Transactions"
                value={String(
                  debits
                    ?.length ??
                    0,
                )}
              />
            </dl>

            <p className="mt-4 rounded-lg bg-muted/60 px-3 py-2 text-sm">
              {debitTotal >
              creditTotal
                ? `Debit more than Credit by ${money(
                    difference,
                  )}`
                : creditTotal >
                    debitTotal
                  ? `Credit more than Debit by ${money(
                      difference,
                    )}`
                  : "Credit and Debit are equal"}
            </p>

            {/* DEBIT MODE BREAKDOWN */}

            {debits?.length ? (
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Debit mode
                  breakdown
                </p>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {breakdown.map(
                    (
                      item,
                    ) => (
                      <div
                        key={
                          item.mode
                        }
                        className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2 text-xs"
                      >
                        <span>
                          {
                            item.mode
                          }
                        </span>

                        <span className="font-mono">
                          {money(
                            item.volume,
                          )}
                          {" — "}
                          {
                            item.count
                          }{" "}
                          txn
                          {item.count ===
                          1
                            ? ""
                            : "s"}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            ) : null}

            {/* TABS */}

            <div className="mt-5 flex gap-2">
              <Button
                size="sm"
                variant={
                  tab ===
                  "credit"
                    ? "default"
                    : "secondary"
                }
                onClick={() =>
                  setTab(
                    "credit",
                  )
                }
              >
                See Credit
              </Button>

              <Button
                size="sm"
                variant={
                  tab ===
                  "debit"
                    ? "default"
                    : "secondary"
                }
                onClick={() =>
                  setTab(
                    "debit",
                  )
                }
              >
                See Debit
              </Button>
            </div>
          </section>
        ) : null}

        {/* RESULT TABLE */}

        {hasResults ? (
          <section className="overflow-hidden rounded-xl border bg-card shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-surface-ledger px-5 py-4">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <FileText
                    className="h-4 w-4 text-primary"
                    aria-hidden
                  />

                  {tab ===
                  "credit"
                    ? `${credits?.length ?? 0} UPI Credit Transaction${
                        (
                          credits
                            ?.length ??
                          0
                        ) ===
                        1
                          ? ""
                          : "s"
                      }`
                    : `${debits?.length ?? 0} Debit Transaction${
                        (
                          debits
                            ?.length ??
                          0
                        ) ===
                        1
                          ? ""
                          : "s"
                      }`}
                </h2>
              </div>

              <div className="flex items-center gap-4">
                <span className="font-mono text-sm font-semibold">
                  {money(
                    tab ===
                      "credit"
                      ? creditTotal
                      : debitTotal,
                  )}
                </span>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={
                    downloadCsv
                  }
                  disabled={
                    visibleRows.length ===
                    0
                  }
                >
                  <Download className="mr-1 h-4 w-4" />

                  Download CSV
                </Button>
              </div>
            </div>

            {visibleRows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs tracking-wide text-muted-foreground uppercase">
                      <th className="px-5 py-3 font-medium">
                        Date
                      </th>

                      <th className="px-5 py-3 font-medium">
                        {tab ===
                        "credit"
                          ? "UTR"
                          : "UTR / Reference"}
                      </th>

                      <th className="px-5 py-3 text-right font-medium">
                        Amount
                      </th>

                      <th className="px-5 py-3 font-medium">
                        Mode
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {visibleRows.map(
                      (
                        row,
                        index,
                      ) => (
                        <tr
                          key={`${row.date}-${row.utr}-${row.amount}-${index}`}
                          className="border-b last:border-0 hover:bg-muted/60"
                        >
                          <td className="px-5 py-3 font-mono whitespace-nowrap">
                            {
                              row.date
                            }
                          </td>

                          <td className="px-5 py-3 font-mono whitespace-nowrap">
                            {
                              row.utr
                            }
                          </td>

                          <td className="px-5 py-3 text-right font-mono whitespace-nowrap">
                            {
                              row.amount
                            }
                          </td>

                          <td className="px-5 py-3">
                            {
                              row.mode
                            }
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  {tab ===
                  "credit"
                    ? "No valid UPI Credit transactions were found."
                    : "No valid UPI, IMPS, NEFT or RTGS Debit transactions were found."}
                </p>
              </div>
            )}
          </section>
        ) : null}

        {/* DEBUG */}

        {devMode &&
        debug ? (
          <section className="rounded-xl border bg-card p-5 shadow-card">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">
                Credit Parser
                Debug
              </h2>

              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setShowDebug(
                    (
                      value,
                    ) =>
                      !value,
                  )
                }
              >
                {showDebug
                  ? "Hide rows"
                  : "Show rows"}
              </Button>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
              <SummaryItem
                label="Input Lines"
                value={String(
                  debug.inputLines,
                )}
              />

              <SummaryItem
                label="Transaction Rows"
                value={String(
                  debug.transactionRows,
                )}
              />

              <SummaryItem
                label="UPI Rows"
                value={String(
                  debug.upiRows,
                )}
              />

              <SummaryItem
                label="Rows With Ref"
                value={String(
                  debug.rowsWithReference,
                )}
              />

              <SummaryItem
                label="Credit Rows"
                value={String(
                  debug.creditRows,
                )}
              />

              <SummaryItem
                label="Accepted"
                value={String(
                  debug.accepted,
                )}
              />
            </dl>

            {showDebug ? (
              <div className="mt-4 max-h-96 overflow-auto rounded-lg border">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="px-2 py-2">
                        Row
                      </th>

                      <th className="px-2 py-2">
                        Direction
                      </th>

                      <th className="px-2 py-2">
                        Amount
                      </th>

                      <th className="px-2 py-2">
                        Status
                      </th>

                      <th className="px-2 py-2">
                        Reason
                      </th>

                      <th className="px-2 py-2">
                        Preview
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {debug.rows.map(
                      (
                        row,
                      ) => (
                        <tr
                          key={
                            row.index
                          }
                          className="border-t"
                        >
                          <td className="px-2 py-2">
                            {
                              row.index
                            }
                          </td>

                          <td className="px-2 py-2">
                            {
                              row.direction
                            }
                          </td>

                          <td className="px-2 py-2">
                            {row.amount ??
                              "-"}
                          </td>

                          <td className="px-2 py-2">
                            {row.accepted
                              ? "OK"
                              : "SKIP"}
                          </td>

                          <td className="px-2 py-2">
                            {row.reason ??
                              "-"}
                          </td>

                          <td className="max-w-md px-2 py-2">
                            {
                              row.preview
                            }
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}

function SummaryItem({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg bg-surface-ledger px-3 py-2">
      <dt className="text-xs text-muted-foreground">
        {label}
      </dt>

      <dd className="font-mono text-sm font-semibold">
        {value}
      </dd>
    </div>
  );
}
