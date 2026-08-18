/* ========================================================================== *
 * UNIVERSAL DEBIT PARSER
 *
 * Thin compatibility layer over statement-core.ts.
 *
 * IMPORTANT:
 * - Debit/Credit understanding happens in statement-core.ts.
 * - This file does NOT independently guess direction anymore.
 * - Valid debit is retained even when UTR/reference is missing.
 * - Payment-network debits:
 *     UPI / IMPS / NEFT / RTGS
 * - Other valid debits:
 *     charges / tax / self / cash / internal / StCon / misc.
 * ========================================================================== */

import {
  detectMode as coreDetectMode,
  extractReference,
  formatAmount,
  isAnyDebit,
  isOtherDebit,
  isPaymentDebit,
  mergeCoreResults,
  normalizeText,
  parseStatementRows,
  parseStatementText,
  type CoreResult,
  type CoreTransaction,
  type PaymentMode,
  type Row,
  type ColumnMap,
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
  rows: DebitTxn[];

  allRows?: DebitTxn[];

  paymentRows?: DebitTxn[];

  otherRows?: DebitTxn[];
};

/* -------------------------------------------------------------------------- *
 * Backward-compatible mode detector
 * -------------------------------------------------------------------------- */

export function detectMode(
  text: string,
): DebitMode | null {
  const mode =
    coreDetectMode(
      text,
    );

  return mode;
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
  const row =
    cells?.length
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
 * CORE -> DEBIT TRANSACTION
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
 * DEDUPE
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
     * Real reference is strongest identity.
     *
     * For N/A rows we deliberately do not aggressively dedupe,
     * because two legitimate same-date / same-amount debits can exist.
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
            row,
          ): row is DebitTxn =>
            row !== null,
        ),
    );

  const paymentRows =
    allRows.filter(
      (
        row,
      ) =>
        row.mode ===
          "UPI" ||
        row.mode ===
          "IMPS" ||
        row.mode ===
          "NEFT" ||
        row.mode ===
          "RTGS",
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
   * IMPORTANT:
   *
   * rows = ALL DEBITS
   *
   * This fixes the earlier problem where legitimate debit rows
   * such as StCon / charges / internal debit disappeared.
   *
   * UI can separately use paymentRows if only
   * UPI/IMPS/NEFT/RTGS are required.
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

export function parseDebitsFromRows(
  rows: Row[],
): DebitResult {
  const normalized =
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
 * - multiple sheets
 * - multiple files
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
 * MERGE EXISTING DEBIT RESULTS
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
          result.rows ??
          [],
      ),
    );

  const paymentRows =
    allRows.filter(
      (
        row,
      ) =>
        row.mode ===
          "UPI" ||
        row.mode ===
          "IMPS" ||
        row.mode ===
          "NEFT" ||
        row.mode ===
          "RTGS",
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
 * PAYMENT-ONLY HELPERS
 * ========================================================================== */

export function paymentDebitRows(
  rows: DebitTxn[],
): DebitTxn[] {
  return rows.filter(
    (
      row,
    ) =>
      row.mode ===
        "UPI" ||
      row.mode ===
        "IMPS" ||
      row.mode ===
        "NEFT" ||
      row.mode ===
        "RTGS",
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
 * FILE NAME
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
