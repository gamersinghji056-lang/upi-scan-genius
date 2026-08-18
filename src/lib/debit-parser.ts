/* ========================================================================== *
 * UNIVERSAL DEBIT PARSER
 *
 * Thin compatibility layer over statement-core.ts V3.
 *
 * IMPORTANT:
 * - Debit/Credit understanding happens in statement-core.ts.
 * - This file does not independently guess direction.
 * - Valid debit is retained even if reference/UTR is unavailable.
 * - Payment-network debits:
 *     UPI / IMPS / NEFT / RTGS
 * - Other debits:
 *     charges / tax / cash / self / internal / StCon / miscellaneous
 * ========================================================================== */

import {
  detectMode as coreDetectMode,
  extractReference,
  formatAmount,
  isAnyDebit,
  mergeCoreResults,
  normalizeText,
  parseStatementRows,
  parseStatementText,
  type ColumnMap,
  type CoreResult,
  type CoreTransaction,
  type Row,
} from "./statement-core";

/* -------------------------------------------------------------------------- *
 * Public types
 * -------------------------------------------------------------------------- */

export type DebitMode =
  | "UPI"
  | "IMPS"
  | "NEFT"
  | "RTGS"
  | "OTHER";

export type DebitTxn = {
  date: string;
  utr: string;
  amount: string;
  mode: DebitMode;
};

export type DebitResult = {
  /*
   * Backward-compatible primary result.
   * rows always contains ALL valid debits.
   */
  rows: DebitTxn[];

  /*
   * Explicit groups for UI.
   */
  allRows: DebitTxn[];
  paymentRows: DebitTxn[];
  otherRows: DebitTxn[];
};

/* -------------------------------------------------------------------------- *
 * Backward-compatible mode detector
 * -------------------------------------------------------------------------- */

export function detectMode(
  text: string,
): DebitMode | null {
  return coreDetectMode(
    text,
  );
}

/* -------------------------------------------------------------------------- *
 * Backward-compatible reference extractor
 * -------------------------------------------------------------------------- */

export function extractDebitRef(
  text: string,
  mode: DebitMode,
  cells?: Row,
  cols?: ColumnMap | null,
): string | null {
  const row: Row =
    cells &&
    cells.length > 0
      ? cells
      : [
          normalizeText(
            text,
          ),
        ];

  return extractReference(
    row,
    cols ?? null,
    mode,
  );
}

/* ========================================================================== *
 * CORE -> DEBIT
 * ========================================================================== */

function toDebitTxn(
  transaction: CoreTransaction,
): DebitTxn | null {
  if (
    !isAnyDebit(
      transaction,
    )
  ) {
    return null;
  }

  if (
    transaction.amount ===
      null ||
    transaction.amount <=
      0
  ) {
    return null;
  }

  return {
    date:
      transaction.date,

    utr:
      transaction.reference ??
      "N/A",

    amount:
      formatAmount(
        transaction.amount,
      ),

    mode:
      transaction.mode,
  };
}

/* ========================================================================== *
 * DEDUPLICATION
 * ========================================================================== */

function dedupeDebits(
  rows: DebitTxn[],
): DebitTxn[] {
  const seen =
    new Set<string>();

  const output:
    DebitTxn[] = [];

  for (
    const row of rows
  ) {
    /*
     * Reference-backed transaction:
     * use reference + mode + amount as identity.
     *
     * N/A transactions are intentionally not aggressively deduplicated,
     * because two genuine debits may have the same date and amount.
     */
    if (
      row.utr !== "N/A"
    ) {
      const key =
        [
          row.utr,
          row.mode,
          row.amount,
        ]
          .join("|")
          .toUpperCase();

      if (
        seen.has(
          key,
        )
      ) {
        continue;
      }

      seen.add(
        key,
      );
    }

    output.push(
      row,
    );
  }

  return output;
}

/* ========================================================================== *
 * RESULT BUILDER
 * ========================================================================== */

function isPaymentMode(
  mode: DebitMode,
): boolean {
  return (
    mode === "UPI" ||
    mode === "IMPS" ||
    mode === "NEFT" ||
    mode === "RTGS"
  );
}

function resultFromCore(
  core: CoreResult,
): DebitResult {
  const allRows =
    dedupeDebits(
      core.transactions
        .map(
          toDebitTxn,
        )
        .filter(
          (
            transaction,
          ): transaction is DebitTxn =>
            transaction !==
            null,
        ),
    );

  const paymentRows =
    allRows.filter(
      (
        row,
      ) =>
        isPaymentMode(
          row.mode,
        ),
    );

  const otherRows =
    allRows.filter(
      (
        row,
      ) =>
        row.mode ===
        "OTHER",
    );

  /*
   * rows intentionally means ALL DEBITS.
   *
   * This prevents legitimate debit rows such as:
   * - StCon
   * - charges
   * - GST
   * - SELF
   * - cash
   * - internal transfer
   *
   * from silently disappearing.
   */
  return {
    rows:
      allRows,

    allRows,

    paymentRows,

    otherRows,
  };
}

/* ========================================================================== *
 * PUBLIC PARSERS
 * ========================================================================== */

/**
 * Native PDF text / OCR text / TXT.
 */
export function parseDebitsFromText(
  text: string,
): DebitResult {
  const core =
    parseStatementText(
      text,
    );

  return resultFromCore(
    core,
  );
}

/**
 * XLS / XLSX / CSV structured rows.
 */
export function parseDebitsFromRows(
  rows: Row[],
): DebitResult {
  const normalized:
    Row[] =
    rows.map(
      (
        row,
      ) =>
        row.map(
          (
            cell,
          ) =>
            normalizeText(
              cell,
            ),
        ),
    );

  const core =
    parseStatementRows(
      normalized,
    );

  return resultFromCore(
    core,
  );
}

/* ========================================================================== *
 * CORE MERGE
 *
 * Useful for:
 * - native PDF + OCR
 * - multiple parser passes
 * ========================================================================== */

export function parseAndMergeDebitCoreTexts(
  texts: string[],
): DebitResult {
  const cores =
    texts.map(
      (
        text,
      ) =>
        parseStatementText(
          text,
        ),
    );

  const merged =
    mergeCoreResults(
      cores,
    );

  return resultFromCore(
    merged,
  );
}

/* ========================================================================== *
 * MERGE DEBIT RESULTS
 * ========================================================================== */

export function mergeDebitResults(
  list: DebitResult[],
): DebitResult {
  if (
    list.length === 0
  ) {
    return {
      rows: [],
      allRows: [],
      paymentRows: [],
      otherRows: [],
    };
  }

  const allRows =
    dedupeDebits(
      list.flatMap(
        (
          result,
        ) =>
          result.allRows ??
          result.rows,
      ),
    );

  const paymentRows =
    allRows.filter(
      (
        row,
      ) =>
        isPaymentMode(
          row.mode,
        ),
    );

  const otherRows =
    allRows.filter(
      (
        row,
      ) =>
        row.mode ===
        "OTHER",
    );

  return {
    rows:
      allRows,

    allRows,

    paymentRows,

    otherRows,
  };
}

/* ========================================================================== *
 * MODE BREAKDOWN
 * ========================================================================== */

export type ModeBreakdown = {
  mode: DebitMode;
  volume: number;
  count: number;
};

export function debitBreakdown(
  rows: DebitTxn[],
): ModeBreakdown[] {
  const modes:
    DebitMode[] = [
      "UPI",
      "IMPS",
      "NEFT",
      "RTGS",
      "OTHER",
    ];

  return modes.map(
    (
      mode,
    ) => {
      const selected =
        rows.filter(
          (
            row,
          ) =>
            row.mode ===
            mode,
        );

      return {
        mode,

        volume:
          selected.reduce(
            (
              total,
              row,
            ) =>
              total +
              Number(
                row.amount,
              ),
            0,
          ),

        count:
          selected.length,
      };
    },
  );
}

/* ========================================================================== *
 * FILTER HELPERS
 * ========================================================================== */

export function paymentDebitRows(
  rows: DebitTxn[],
): DebitTxn[] {
  return rows.filter(
    (
      row,
    ) =>
      isPaymentMode(
        row.mode,
      ),
  );
}

export function otherDebitRows(
  rows: DebitTxn[],
): DebitTxn[] {
  return rows.filter(
    (
      row,
    ) =>
      row.mode ===
      "OTHER",
  );
}

/* ========================================================================== *
 * TOTAL HELPERS
 * ========================================================================== */

export function paymentDebitTotal(
  rows: DebitTxn[],
): number {
  return paymentDebitRows(
    rows,
  ).reduce(
    (
      total,
      row,
    ) =>
      total +
      Number(
        row.amount,
      ),
    0,
  );
}

export function allDebitTotal(
  rows: DebitTxn[],
): number {
  return rows.reduce(
    (
      total,
      row,
    ) =>
      total +
      Number(
        row.amount,
      ),
    0,
  );
}

export function otherDebitTotal(
  rows: DebitTxn[],
): number {
  return otherDebitRows(
    rows,
  ).reduce(
    (
      total,
      row,
    ) =>
      total +
      Number(
        row.amount,
      ),
    0,
  );
}

/* ========================================================================== *
 * INDIVIDUAL MODE TOTALS
 * ========================================================================== */

export function debitModeRows(
  rows: DebitTxn[],
  mode: DebitMode,
): DebitTxn[] {
  return rows.filter(
    (
      row,
    ) =>
      row.mode ===
      mode,
  );
}

export function debitModeTotal(
  rows: DebitTxn[],
  mode: DebitMode,
): number {
  return debitModeRows(
    rows,
    mode,
  ).reduce(
    (
      total,
      row,
    ) =>
      total +
      Number(
        row.amount,
      ),
    0,
  );
}

/* ========================================================================== *
 * CSV
 * ========================================================================== */

function csvEscape(
  value: string,
): string {
  if (
    /[",\n\r]/.test(
      value,
    )
  ) {
    return `"${value.replace(
      /"/g,
      '""',
    )}"`;
  }

  return value;
}

export function toDebitCsv(
  rows: DebitTxn[],
): string {
  const lines = [
    [
      "Date",
      "UTR / Reference",
      "Amount",
      "Mode",
    ].join(","),
  ];

  for (
    const row of rows
  ) {
    lines.push(
      [
        csvEscape(
          row.date,
        ),

        csvEscape(
          row.utr,
        ),

        csvEscape(
          row.amount,
        ),

        csvEscape(
          row.mode,
        ),
      ].join(","),
    );
  }

  return lines.join(
    "\n",
  );
}

/* ========================================================================== *
 * TIMESTAMPED FILE NAME
 * ========================================================================== */

export function timestampName(
  prefix: string,
): string {
  const date =
    new Date();

  const pad =
    (
      value: number,
    ) =>
      String(
        value,
      ).padStart(
        2,
        "0",
      );

  return `${prefix}_${date.getFullYear()}${pad(
    date.getMonth() + 1,
  )}${pad(
    date.getDate(),
  )}_${pad(
    date.getHours(),
  )}${pad(
    date.getMinutes(),
  )}${pad(
    date.getSeconds(),
  )}.csv`;
}
