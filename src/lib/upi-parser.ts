/* ========================================================================== *
 * UPI CREDIT PARSER
 *
 * Thin compatibility layer over statement-core.ts.
 *
 * IMPORTANT:
 * - Transaction understanding happens in statement-core.ts.
 * - This file filters ONLY UPI CREDIT transactions.
 * - It does NOT independently guess debit/credit direction anymore.
 * - Missing UTR does NOT delete a valid UPI credit transaction.
 *   It is returned as "N/A".
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
 *
 * Keep these compatible with the existing UI.
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

  rows:
    RowDiagnostic[];
};

export type ExtractResult = {
  rows: UpiCredit[];

  debug: ExtractDebug;
};

/* ========================================================================== *
 * UPI REFERENCE HELPERS
 * ========================================================================== */

/**
 * Returns all standalone 12-digit numeric candidates.
 *
 * Kept for backward compatibility and debugging.
 */
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

/**
 * Uses the SAME shared reference intelligence as statement-core.
 *
 * Priority is therefore consistent with:
 *
 * - UTR
 * - RRN
 * - dedicated reference
 * - UPI-specific reference
 * - generic candidate
 */
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
  transaction:
    CoreTransaction,
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

    /*
     * Do not silently delete valid credits
     * merely because bank does not expose a usable UTR.
     */
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

  return {
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

    reason:
      transactionReason(
        transaction,
        accepted,
      ),
  };
}

/* ========================================================================== *
 * RESULT BUILDER
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
     * A real UTR is the strongest identity.
     *
     * When UTR is N/A, include amount and date so
     * separate valid transactions do not collapse unnecessarily.
     */
    const key =
      row.utr !== "N/A"
        ? `REF|${row.utr}`
        : `NOREF|${row.date}|${row.amount}|${output.length}`;

    if (
      row.utr !==
        "N/A" &&
      seen.has(
        key,
      )
    ) {
      continue;
    }

    if (
      row.utr !==
      "N/A"
    ) {
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

function resultFromCore(
  core: CoreResult,
  inputLines: number,
): ExtractResult {
  const converted =
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
      );

  const rows =
    dedupe(
      converted,
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
        core.transactions
          .length,

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

/**
 * PDF native text / OCR / TXT.
 */
export function parseTextDetailed(
  text: string,
): ExtractResult {
  const inputLines =
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
      ).length;

  const core =
    parseStatementText(
      text,
    );

  return resultFromCore(
    core,
    inputLines,
  );
}

/**
 * XLS / XLSX / CSV structured rows.
 */
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
 * MERGE
 *
 * Used by statement-readers when:
 * - multiple files are uploaded
 * - PDF native text + OCR both produce results
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

        rowsWithReference:
          0,

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
            result.debug
              .inputLines,
          0,
        ),

      transactionRows:
        list.reduce(
          (
            total,
            result,
          ) =>
            total +
            result.debug
              .transactionRows,
          0,
        ),

      upiRows:
        list.reduce(
          (
            total,
            result,
          ) =>
            total +
            result.debug
              .upiRows,
          0,
        ),

      rowsWithReference:
        list.reduce(
          (
            total,
            result,
          ) =>
            total +
            result.debug
              .rowsWithReference,
          0,
        ),

      creditRows:
        list.reduce(
          (
            total,
            result,
          ) =>
            total +
            result.debug
              .creditRows,
          0,
        ),

      accepted:
        rows.length,

      columns:
        list.find(
          (
            result,
          ) =>
            result.debug
              .columns !==
            null,
        )?.debug
          .columns ??
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
 * OPTIONAL CORE MERGE
 *
 * This export is useful for the upcoming statement-readers update.
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
        text
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
