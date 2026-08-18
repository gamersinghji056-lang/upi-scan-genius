/* ========================================================================== *
 * UPI CREDIT PARSER
 *
 * Thin compatibility layer over statement-core.ts.
 *
 * IMPORTANT:
 * - Transaction understanding happens in statement-core.ts.
 * - This file only filters UPI CREDIT transactions.
 * - Missing UTR does not delete a valid UPI credit transaction.
 * ========================================================================== */

import {
  detectColumns as coreDetectColumns,
  extractDate as coreExtractDate,
  extractReference,
  formatAmount,
  isUpiCredit,
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
 * Backward-compatible exports
 * -------------------------------------------------------------------------- */

export type {
  Row,
  ColumnMap,
};

export const detectColumns =
  coreDetectColumns;

export const extractDate =
  coreExtractDate;

/* -------------------------------------------------------------------------- *
 * Public transaction type
 * -------------------------------------------------------------------------- */

export type UpiCredit = {
  date: string;
  utr: string;
  amount: string;
  mode: "UPI";
};

/* -------------------------------------------------------------------------- *
 * Debug types
 * -------------------------------------------------------------------------- */

export type RowDiagnostic = {
  index: number;
  preview: string;
  hasDate: boolean;
  isUpi: boolean;
  references: number;

  direction:
    | "credit"
    | "debit"
    | "unknown";

  amount:
    | string
    | null;

  accepted: boolean;

  reason?: string;
};

export type ExtractDebug = {
  inputLines: number;
  transactionRows: number;
  upiRows: number;
  rowsWithReference: number;
  creditRows: number;
  accepted: number;

  columns:
    | ColumnMap
    | null;

  rows: RowDiagnostic[];
};

export type ExtractResult = {
  rows: UpiCredit[];
  debug: ExtractDebug;
};

/* ========================================================================== *
 * UPI REFERENCE HELPERS
 * ========================================================================== */

export function extractUtrCandidates(
  text: string,
): string[] {
  const normalized =
    normalizeText(
      text,
    );

  return (
    normalized.match(
      /(?<!\d)\d{12}(?!\d)/g,
    ) ?? []
  );
}

export function extractUtr(
  text: string,
): string | null {
  const normalized =
    normalizeText(
      text,
    );

  if (!normalized) {
    return null;
  }

  return extractReference(
    [
      normalized,
    ],
    null,
    "UPI",
  );
}

/* ========================================================================== *
 * CORE -> UPI CREDIT
 * ========================================================================== */

function toUpiCredit(
  transaction: CoreTransaction,
): UpiCredit | null {
  if (
    !isUpiCredit(
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
      "UPI",
  };
}

/* ========================================================================== *
 * DIAGNOSTICS
 * ========================================================================== */

function transactionReason(
  transaction:
    CoreTransaction,
  accepted: boolean,
): string | undefined {
  if (accepted) {
    return undefined;
  }

  if (
    transaction.mode !==
    "UPI"
  ) {
    return "Not a UPI transaction";
  }

  if (
    transaction.direction ===
    "debit"
  ) {
    return "UPI debit row";
  }

  if (
    transaction.direction ===
    "unknown"
  ) {
    return "Transaction direction could not be proven as credit";
  }

  if (
    transaction.amount ===
      null ||
    transaction.amount <=
      0
  ) {
    return "No valid credit amount";
  }

  return "Not accepted as UPI credit";
}

function transactionDiagnostic(
  transaction:
    CoreTransaction,
): RowDiagnostic {
  const accepted =
    isUpiCredit(
      transaction,
    ) &&
    transaction.amount !==
      null &&
    transaction.amount >
      0;

  const diagnostic:
    RowDiagnostic = {
      index:
        transaction.rowIndex,

      preview:
        transaction.raw.slice(
          0,
          220,
        ),

      hasDate:
        Boolean(
          transaction.date,
        ),

      isUpi:
        transaction.mode ===
        "UPI",

      references:
        transaction.reference
          ? 1
          : 0,

      direction:
        transaction.direction,

      amount:
        transaction.amount ===
        null
          ? null
          : formatAmount(
              transaction.amount,
            ),

      accepted,
    };

  const reason =
    transactionReason(
      transaction,
      accepted,
    );

  /*
   * exactOptionalPropertyTypes-safe:
   * only add reason when a string really exists.
   */
  if (
    reason !== undefined
  ) {
    diagnostic.reason =
      reason;
  }

  return diagnostic;
}

/* ========================================================================== *
 * DEDUPE
 * ========================================================================== */

function dedupe(
  rows: UpiCredit[],
): UpiCredit[] {
  const seen =
    new Set<string>();

  const output:
    UpiCredit[] = [];

  for (
    const row of rows
  ) {
    /*
     * Real UTR/reference is strongest identity.
     *
     * For N/A rows we do not aggressively dedupe because
     * two same-date / same-amount real credits can exist.
     */
    if (
      row.utr !== "N/A"
    ) {
      const key =
        [
          row.utr,
          row.amount,
          row.mode,
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
  inputLines: number,
): ExtractResult {
  const rows =
    dedupe(
      core.transactions
        .map(
          toUpiCredit,
        )
        .filter(
          (
            transaction,
          ): transaction is UpiCredit =>
            transaction !==
            null,
        ),
    );

  const diagnostics =
    core.transactions.map(
      transactionDiagnostic,
    );

  return {
    rows,

    debug: {
      inputLines,

      transactionRows:
        core.transactions.length,

      upiRows:
        core.transactions.filter(
          (
            transaction,
          ) =>
            transaction.mode ===
            "UPI",
        ).length,

      rowsWithReference:
        core.transactions.filter(
          (
            transaction,
          ) =>
            Boolean(
              transaction.reference,
            ),
        ).length,

      creditRows:
        core.transactions.filter(
          (
            transaction,
          ) =>
            transaction.direction ===
            "credit",
        ).length,

      accepted:
        rows.length,

      columns:
        core.columns,

      rows:
        diagnostics,
    },
  };
}

/* ========================================================================== *
 * PUBLIC PARSERS
 * ========================================================================== */

export function parseTextDetailed(
  text: string,
): ExtractResult {
  const normalized =
    String(
      text ?? "",
    ).replace(
      /\r\n?/g,
      "\n",
    );

  const inputLines =
    normalized
      .split(
        "\n",
      )
      .filter(
        (
          line,
        ) =>
          Boolean(
            line.trim(),
          ),
      ).length;

  const core =
    parseStatementText(
      normalized,
    );

  return resultFromCore(
    core,
    inputLines,
  );
}

export function parseRowsDetailed(
  rows: Row[],
): ExtractResult {
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
    normalized.length,
  );
}

export function parseText(
  text: string,
): UpiCredit[] {
  return parseTextDetailed(
    text,
  ).rows;
}

export function parseRows(
  rows: Row[],
): UpiCredit[] {
  return parseRowsDetailed(
    rows,
  ).rows;
}

/* ========================================================================== *
 * MERGE EXISTING RESULTS
 * ========================================================================== */

export function mergeResults(
  list:
    ExtractResult[],
): ExtractResult {
  if (
    list.length === 0
  ) {
    return {
      rows: [],

      debug: {
        inputLines: 0,
        transactionRows: 0,
        upiRows: 0,
        rowsWithReference: 0,
        creditRows: 0,
        accepted: 0,
        columns: null,
        rows: [],
      },
    };
  }

  const rows =
    dedupe(
      list.flatMap(
        (
          result,
        ) =>
          result.rows,
      ),
    );

  return {
    rows,

    debug: {
      inputLines:
        list.reduce(
          (
            total,
            result,
          ) =>
            total +
            result.debug.inputLines,
          0,
        ),

      transactionRows:
        list.reduce(
          (
            total,
            result,
          ) =>
            total +
            result.debug.transactionRows,
          0,
        ),

      upiRows:
        list.reduce(
          (
            total,
            result,
          ) =>
            total +
            result.debug.upiRows,
          0,
        ),

      rowsWithReference:
        list.reduce(
          (
            total,
            result,
          ) =>
            total +
            result.debug.rowsWithReference,
          0,
        ),

      creditRows:
        list.reduce(
          (
            total,
            result,
          ) =>
            total +
            result.debug.creditRows,
          0,
        ),

      accepted:
        rows.length,

      columns:
        list.find(
          (
            result,
          ) =>
            result.debug.columns !==
            null,
        )?.debug.columns ??
        null,

      rows:
        list.flatMap(
          (
            result,
          ) =>
            result.debug.rows,
        ),
    },
  };
}

/* ========================================================================== *
 * CORE MERGE
 *
 * Used later by statement-readers for:
 * - native PDF + OCR
 * - multiple text passes
 * ========================================================================== */

export function parseAndMergeCoreTexts(
  texts: string[],
): ExtractResult {
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

  const inputLines =
    texts.reduce(
      (
        total,
        text,
      ) =>
        total +
        String(
          text ?? "",
        )
          .replace(
            /\r\n?/g,
            "\n",
          )
          .split(
            "\n",
          )
          .filter(
            (
              line,
            ) =>
              Boolean(
                line.trim(),
              ),
          ).length,
      0,
    );

  return resultFromCore(
    merged,
    inputLines,
  );
}

/* ========================================================================== *
 * CSV EXPORT
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

export function toCsv(
  rows:
    UpiCredit[],
): string {
  const lines = [
    [
      "Date",
      "UTR",
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

        row.mode,
      ].join(","),
    );
  }

  return lines.join(
    "\n",
  );
}
