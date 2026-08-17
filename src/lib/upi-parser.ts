/* ------------------------------------------------------------------ *
 * Universal UPI CREDIT parser.
 *
 * Purpose:
 * - Extract ONLY UPI credit transactions.
 * - Keep this parser independent from debit-parser.ts.
 * - Bank/layout independent, row based.
 * ------------------------------------------------------------------ */

export type UpiCredit = {
  date: string;
  utr: string;
  amount: string;
  mode: "UPI";
};

export type Row = string[];

const UPI_RE = /\bupi\b|upi[\s/\-:_]|\bmpay\s*\/\s*upi\b|\btrtr\b/i;

const CREDIT_WORDS =
  /\b(cr|crd|credit|credits|credited|credit\s*amount|credit\s*value|deposit|deposits|received|receipt|incoming|inward)\b/i;

const DEBIT_WORDS =
  /\b(dr|debit|debits|debited|debit\s*amount|debit\s*value|withdraw|withdrawal|withdrawals|withdrawn|sent|paid|payment\s*out|outgoing|outward)\b/i;

const BALANCE_WORDS = /\b(balance|bal|closing|running|available)\b/i;

const DATE_WORDS =
  /\b(date|dt|transaction\s*date|tran\.?\s*date|post\s*date)\b/i;

const AMOUNT_WORDS =
  /\b(amount|amt|value|transaction\s*amount)\b/i;

const TYPE_WORDS =
  /(type|cr\s*[/|]\s*dr|dr\s*[/|]\s*cr|indicator|dr\s*\/\s*cr)/i;

const NARRATION_WORDS =
  /(narration|description|particular|particulars|remark|remarks|details|transaction\s*detail|account\s*description)/i;

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

const DATE_PATTERNS: RegExp[] = [
  /\b(\d{2})[-/.](\d{2})[-/.](\d{4})\b/,
  /\b(\d{4})[-/.](\d{2})[-/.](\d{2})\b/,
  /\b(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})\b/,
  /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/,
];

function pad(n: string) {
  return n.padStart(2, "0");
}

/**
 * Returns DD/MM/YYYY or null.
 */
export function extractDate(text: string): string | null {
  const [dmy, ymd, dMon, dmy2] = DATE_PATTERNS as [
    RegExp,
    RegExp,
    RegExp,
    RegExp,
  ];

  let m = dmy.exec(text);

  if (m) {
    return `${m[1]}/${m[2]}/${m[3]}`;
  }

  m = ymd.exec(text);

  if (m) {
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  m = dMon.exec(text);

  if (m) {
    const mon =
      MONTHS[(m[2] ?? "").slice(0, 3).toLowerCase()];

    if (mon) {
      let y = m[3] ?? "";

      if (y.length === 2) {
        y = Number(y) > 70
          ? `19${y}`
          : `20${y}`;
      }

      return `${pad(m[1] ?? "")}/${mon}/${y}`;
    }
  }

  m = dmy2.exec(text);

  if (m) {
    return `${pad(m[1] ?? "")}/${pad(m[2] ?? "")}/20${m[3]}`;
  }

  return null;
}

/**
 * Every standalone 12-digit numeric value in a row.
 */
export function extractUtrCandidates(
  text: string,
): string[] {
  return text.match(/(?<!\d)\d{12}(?!\d)/g) ?? [];
}

/**
 * Extract best UPI reference.
 *
 * Credit side intentionally remains 12-digit UPI reference based.
 */
export function extractUtr(
  text: string,
): string | null {
  const normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/\s*([/:_-])\s*/g, "$1")
    .replace(/\s+/g, " ");

  const prioritized = [
    /\bUPI\/RRN\/?(\d{12})(?!\d)/i,

    /\bUPI\/(?:CR\/)?(\d{12})(?!\d)/i,

    /\bMPAY\/UPI\/(?:TRTR\/)?(\d{12})(?!\d)/i,

    /\bTRTR\/(\d{12})(?!\d)/i,

    /\bRRN[\s:/_-]*(\d{12})(?!\d)/i,
  ];

  for (const re of prioritized) {
    const m = re.exec(normalized);

    if (m?.[1]) {
      return m[1];
    }
  }

  const all =
    extractUtrCandidates(normalized);

  if (!all.length) {
    return null;
  }

  const upiIdx =
    normalized.search(UPI_RE);

  if (upiIdx >= 0) {
    const after =
      extractUtrCandidates(
        normalized.slice(upiIdx),
      );

    if (after.length) {
      return after[0] ?? null;
    }
  }

  return all[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * Amount detection
 * ------------------------------------------------------------------ */

const MONEY_RE =
  /(?<![\d.])(-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)(?!\d)/g;

function toNumber(
  s: string,
) {
  return Number(
    s.replace(/,/g, ""),
  );
}

/**
 * Money-looking tokens with dates and long references removed.
 */
function moneyTokens(
  text: string,
): string[] {
  const cleaned = text
    .replace(
      /\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}/g,
      " ",
    )
    .replace(
      /(?<!\d)\d{7,}(?!\d)/g,
      " ",
    )
    .replace(
      /(?<!\d)\d{5,6}(?![\d.,])/g,
      " ",
    );

  return cleaned.match(MONEY_RE) ?? [];
}

function cellAmount(
  cell: string,
): number | null {
  const t =
    moneyTokens(cell);

  if (!t.length) {
    return null;
  }

  const n =
    toNumber(
      t[t.length - 1] ?? "",
    );

  return Number.isFinite(n)
    ? n
    : null;
}

/* ------------------------------------------------------------------ *
 * Column detection
 * ------------------------------------------------------------------ */

export type ColumnMap = {
  date?: number;
  narration?: number;
  credit?: number;
  debit?: number;
  amount?: number;
  type?: number;
  balance?: number;
};

/**
 * Detect bank statement columns without depending on fixed position.
 */
export function detectColumns(
  header: Row,
): ColumnMap | null {
  const map: ColumnMap = {};

  let hits = 0;

  header.forEach(
    (raw, i) => {
      const h = (raw || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

      if (
        !h ||
        h.length > 60
      ) {
        return;
      }

      if (
        BALANCE_WORDS.test(h)
      ) {
        if (
          map.balance === undefined
        ) {
          map.balance = i;
        }

        return;
      }

      if (
        DATE_WORDS.test(h) &&
        !/update/.test(h)
      ) {
        if (
          map.date === undefined
        ) {
          map.date = i;
          hits++;
        }

        return;
      }

      if (
        NARRATION_WORDS.test(h)
      ) {
        if (
          map.narration === undefined
        ) {
          map.narration = i;
        }

        hits++;

        return;
      }

      if (
        TYPE_WORDS.test(h)
      ) {
        if (
          map.type === undefined
        ) {
          map.type = i;
        }

        hits++;

        return;
      }

      if (
        CREDIT_WORDS.test(h) &&
        !DEBIT_WORDS.test(h)
      ) {
        if (
          map.credit === undefined
        ) {
          map.credit = i;
        }

        hits++;

        return;
      }

      if (
        DEBIT_WORDS.test(h) &&
        !CREDIT_WORDS.test(h)
      ) {
        if (
          map.debit === undefined
        ) {
          map.debit = i;
        }

        hits++;

        return;
      }

      if (
        AMOUNT_WORDS.test(h)
      ) {
        if (
          map.amount === undefined
        ) {
          map.amount = i;
        }

        hits++;
      }
    },
  );

  return hits >= 2
    ? map
    : null;
}

/* ------------------------------------------------------------------ *
 * Debug types
 * ------------------------------------------------------------------ */

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
  amount: string | null;
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
  columns: ColumnMap | null;
  rows: RowDiagnostic[];
};

export type ExtractResult = {
  rows: UpiCredit[];
  debug: ExtractDebug;
};

function fmtAmount(
  n: number,
) {
  return Math.abs(n)
    .toFixed(2);
}

type RowValue = {
  index: number;
  value: number;
};

function rowValues(
  cells: Row,
  cols: ColumnMap | null,
): RowValue[] {
  /*
   * Plain text row.
   */
  if (
    cells.length === 1
  ) {
    return moneyTokens(
      cells[0] || "",
    ).map(
      (t, i) => ({
        index: i,
        value: toNumber(t),
      }),
    );
  }

  const out: RowValue[] = [];

  cells.forEach(
    (cell, i) => {
      if (
        cols?.date === i ||
        cols?.narration === i
      ) {
        return;
      }

      const v =
        cellAmount(
          cell || "",
        );

      if (
        v !== null
      ) {
        out.push({
          index: i,
          value: v,
        });
      }
    },
  );

  return out;
}

/* ------------------------------------------------------------------ *
 * Direction classification
 * ------------------------------------------------------------------ */

type Classified = {
  direction:
    | "credit"
    | "debit"
    | "unknown";

  amount: number | null;

  balance: number | null;
};

/**
 * Credit/debit direction priority:
 *
 * 1. Dedicated Debit/Credit column
 * 2. Explicit transaction Cr/Dr field
 * 3. Negative amount => Debit
 * 4. Balance delta
 * 5. Narration fallback
 *
 * IMPORTANT:
 * Balance suffix CR/DR must not override transaction direction.
 */
function classifyRow(
  cells: Row,
  text: string,
  cols: ColumnMap | null,
  prevBalance: number | null,
): Classified {
  const values =
    rowValues(
      cells,
      cols,
    );

  let balance:
    number | null = null;

  let balanceIdx:
    number | null = null;

  /*
   * Balance column.
   */
  if (
    cols?.balance !== undefined
  ) {
    const v =
      cellAmount(
        cells[
          cols.balance
        ] || "",
      );

    if (
      v !== null
    ) {
      balance =
        Math.abs(v);

      balanceIdx =
        cols.balance;
    }
  } else if (
    values.length >= 2
  ) {
    const last =
      values[
        values.length - 1
      ]!;

    balance =
      Math.abs(
        last.value,
      );

    balanceIdx =
      last.index;
  }

  const nonBalance =
    values.filter(
      (v) =>
        v.index !==
        balanceIdx,
    );

  /*
   * 1. Explicit Debit/Credit columns.
   */
  if (
    cols?.credit !== undefined ||
    cols?.debit !== undefined
  ) {
    const credit =
      cols?.credit !== undefined
        ? cellAmount(
            cells[
              cols.credit
            ] || "",
          )
        : null;

    const debit =
      cols?.debit !== undefined
        ? cellAmount(
            cells[
              cols.debit
            ] || "",
          )
        : null;

    if (
      debit !== null &&
      debit !== 0
    ) {
      return {
        direction:
          "debit",

        amount:
          Math.abs(
            debit,
          ),

        balance,
      };
    }

    if (
      credit !== null &&
      credit !== 0
    ) {
      return {
        direction:
          "credit",

        amount:
          Math.abs(
            credit,
          ),

        balance,
      };
    }
  }

  /*
   * 2. Explicit transaction indicator.
   */
  const typeCell =
    cols?.type !== undefined
      ? cells[
          cols.type
        ] || ""
      : "";

  const indicator =
    typeCell ||
    cells.find(
      (c) =>
        /^\s*(cr|dr|credit|debit|c|d)\.?\s*$/i.test(
          c || "",
        ),
    ) ||
    "";

  if (
    indicator
  ) {
    if (
      /^\s*(cr|credit|c)\.?\s*$/i.test(
        indicator,
      )
    ) {
      const candidate =
        nonBalance.find(
          (v) =>
            Math.abs(
              v.value,
            ) > 0,
        );

      return {
        direction:
          "credit",

        amount:
          candidate
            ? Math.abs(
                candidate.value,
              )
            : null,

        balance,
      };
    }

    if (
      /^\s*(dr|debit|d)\.?\s*$/i.test(
        indicator,
      )
    ) {
      return {
        direction:
          "debit",

        amount: null,

        balance,
      };
    }
  }

  /*
   * 3. Negative transaction amount = Debit.
   */
  const negative =
    nonBalance.find(
      (v) =>
        v.value < 0,
    );

  if (
    negative
  ) {
    return {
      direction:
        "debit",

      amount:
        Math.abs(
          negative.value,
        ),

      balance,
    };
  }

  /*
   * 4. Balance delta.
   */
  if (
    balance !== null &&
    prevBalance !== null
  ) {
    const delta =
      Number(
        (
          balance -
          prevBalance
        ).toFixed(2),
      );

    const match =
      nonBalance.find(
        (v) =>
          Math.abs(
            Math.abs(
              v.value,
            ) -
              Math.abs(
                delta,
              ),
          ) < 0.02,
      );

    if (
      match &&
      Math.abs(delta) > 0
    ) {
      return {
        direction:
          delta > 0
            ? "credit"
            : "debit",

        amount:
          Math.abs(
            match.value,
          ),

        balance,
      };
    }
  }

  /*
   * 5. Narration fallback.
   */
  const c =
    CREDIT_WORDS.test(
      text,
    );

  const d =
    DEBIT_WORDS.test(
      text,
    );

  if (
    c &&
    !d
  ) {
    const candidate =
      nonBalance.find(
        (v) =>
          Math.abs(
            v.value,
          ) > 0,
      );

    return {
      direction:
        "credit",

      amount:
        candidate
          ? Math.abs(
              candidate.value,
            )
          : null,

      balance,
    };
  }

  if (
    d &&
    !c
  ) {
    return {
      direction:
        "debit",

      amount: null,

      balance,
    };
  }

  return {
    direction:
      "unknown",

    amount: null,

    balance,
  };
}

/* ------------------------------------------------------------------ *
 * Main Credit engine
 * ------------------------------------------------------------------ */

function analyze(
  rowsIn: Row[],
): ExtractResult {
  const diagnostics:
    RowDiagnostic[] = [];

  const results:
    UpiCredit[] = [];

  let cols:
    ColumnMap | null =
    null;

  let headerLen = 0;

  let prevBalance:
    number | null =
    null;

  let transactionRows = 0;

  let upiRows = 0;

  let rowsWithReference = 0;

  let creditRows = 0;

  rowsIn.forEach(
    (raw, i) => {
      const cells =
        raw.map(
          (c) =>
            c == null
              ? ""
              : String(c)
                  .replace(
                    /\s+/g,
                    " ",
                  )
                  .trim(),
        );

      const text =
        cells
          .join(" ")
          .trim();

      if (
        !text
      ) {
        return;
      }

      const push = (
        d: Omit<
          RowDiagnostic,
          "index" | "preview"
        >,
      ) =>
        diagnostics.push({
          index: i,
          preview:
            text.slice(
              0,
              160,
            ),
          ...d,
        });

      /*
       * Opening balance.
       */
      if (
        /\b(opening\s*balance|balance\s*b\/?f|brought\s*forward|b\/f)\b/i.test(
          text,
        )
      ) {
        const t =
          moneyTokens(
            text,
          );

        if (
          t.length
        ) {
          prevBalance =
            Math.abs(
              toNumber(
                t[
                  t.length -
                    1
                ] ?? "",
              ),
            );
        }

        return;
      }

      /*
       * Detect table header.
       */
      const maybeHeader =
        detectColumns(
          cells,
        );

      if (
        maybeHeader &&
        !UPI_RE.test(
          text,
        ) &&
        extractDate(
          text,
        ) === null
      ) {
        cols =
          maybeHeader;

        headerLen =
          cells.length;

        return;
      }

      /*
       * Only trust column indices when row shape matches.
       */
      const rowCols =
        cols &&
        cells.length ===
          headerLen
          ? cols
          : null;

      const dateCell =
        rowCols?.date !== undefined
          ? cells[
              rowCols.date
            ] || ""
          : "";

      const date =
        extractDate(
          dateCell,
        ) ??
        extractDate(
          cells[0] || "",
        ) ??
        extractDate(
          text,
        );

      const refs =
        extractUtrCandidates(
          text,
        );

      const isUpi =
        UPI_RE.test(
          text,
        );

      if (
        !date
      ) {
        push({
          hasDate:
            false,

          isUpi,

          references:
            refs.length,

          direction:
            "unknown",

          amount: null,

          accepted:
            false,

          reason:
            "No date",
        });

        return;
      }

      transactionRows++;

      const cls =
        classifyRow(
          cells,
          text,
          rowCols,
          prevBalance,
        );

      if (
        cls.balance !==
        null
      ) {
        prevBalance =
          cls.balance;
      }

      if (
        isUpi
      ) {
        upiRows++;
      }

      if (
        refs.length
      ) {
        rowsWithReference++;
      }

      if (
        cls.direction ===
        "credit"
      ) {
        creditRows++;
      }

      const base = {
        hasDate:
          true,

        isUpi,

        references:
          refs.length,

        direction:
          cls.direction,

        amount:
          cls.amount ===
          null
            ? null
            : fmtAmount(
                cls.amount,
              ),
      };

      /*
       * Only UPI credit rows.
       */
      if (
        !isUpi
      ) {
        push({
          ...base,

          accepted:
            false,

          reason:
            "No UPI keyword",
        });

        return;
      }

      const utr =
        extractUtr(
          text,
        );

      if (
        !utr
      ) {
        push({
          ...base,

          accepted:
            false,

          reason:
            "No valid 12-digit UPI reference",
        });

        return;
      }

      if (
        cls.direction !==
        "credit"
      ) {
        push({
          ...base,

          accepted:
            false,

          reason:
            cls.direction ===
            "debit"
              ? "Debit row"
              : "Unknown transaction direction",
        });

        return;
      }

      if (
        !cls.amount ||
        cls.amount <= 0
      ) {
        push({
          ...base,

          accepted:
            false,

          reason:
            "No credit amount",
        });

        return;
      }

      results.push({
        date,

        utr,

        amount:
          fmtAmount(
            cls.amount,
          ),

        mode:
          "UPI",
      });

      push({
        ...base,

        accepted:
          true,
      });
    },
  );

  const rows =
    dedupe(
      results,
    );

  return {
    rows,

    debug: {
      inputLines:
        rowsIn.length,

      transactionRows,

      upiRows,

      rowsWithReference,

      creditRows,

      accepted:
        rows.length,

      columns:
        cols,

      rows:
        diagnostics,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Text → rows
 * ------------------------------------------------------------------ */

/**
 * Merge wrapped continuation lines into previous dated transaction.
 */
function stitchLines(
  lines: string[],
): string[] {
  const out:
    string[] = [];

  for (
    const raw of lines
  ) {
    const line =
      raw
        .replace(
          /\u00a0/g,
          " ",
        )
        .trimEnd();

    if (
      !line.trim()
    ) {
      continue;
    }

    if (
      extractDate(
        line,
      ) !== null ||
      out.length === 0
    ) {
      out.push(
        line,
      );
    } else {
      out[
        out.length - 1
      ] +=
        " " +
        line.trim();
    }
  }

  return out;
}

/**
 * Split plain statement line into cells.
 */
function lineToCells(
  line: string,
): Row {
  if (
    line.includes(
      "|",
    )
  ) {
    return line
      .split("|")
      .map(
        (p) =>
          p.trim(),
      );
  }

  if (
    line.includes(
      "\t",
    )
  ) {
    return line
      .split("\t")
      .map(
        (p) =>
          p.trim(),
      );
  }

  const bySpaces =
    line
      .split(
        /\s{2,}/,
      )
      .map(
        (p) =>
          p.trim(),
      );

  if (
    bySpaces.length >=
    3
  ) {
    return bySpaces;
  }

  return [
    line.trim(),
  ];
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export function parseTextDetailed(
  text: string,
): ExtractResult {
  return analyze(
    stitchLines(
      text.split(
        /\r?\n/,
      ),
    ).map(
      lineToCells,
    ),
  );
}

export function parseRowsDetailed(
  rows: Row[],
): ExtractResult {
  return analyze(
    rows.map(
      (r) =>
        r.map(
          (c) =>
            c == null
              ? ""
              : String(c),
        ),
    ),
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

export function mergeResults(
  list: ExtractResult[],
): ExtractResult {
  const rows =
    dedupe(
      list.flatMap(
        (r) =>
          r.rows,
      ),
    );

  return {
    rows,

    debug: {
      inputLines:
        list.reduce(
          (s, r) =>
            s +
            r.debug
              .inputLines,
          0,
        ),

      transactionRows:
        list.reduce(
          (s, r) =>
            s +
            r.debug
              .transactionRows,
          0,
        ),

      upiRows:
        list.reduce(
          (s, r) =>
            s +
            r.debug
              .upiRows,
          0,
        ),

      rowsWithReference:
        list.reduce(
          (s, r) =>
            s +
            r.debug
              .rowsWithReference,
          0,
        ),

      creditRows:
        list.reduce(
          (s, r) =>
            s +
            r.debug
              .creditRows,
          0,
        ),

      accepted:
        rows.length,

      columns:
        list.find(
          (r) =>
            r.debug
              .columns,
        )?.debug
          .columns ??
        null,

      rows:
        list.flatMap(
          (r) =>
            r.debug.rows,
        ),
    },
  };
}

function dedupe(
  list: UpiCredit[],
): UpiCredit[] {
  const seen =
    new Set<string>();

  return list.filter(
    (r) => {
      const key =
        `${r.date}|${r.utr}|${r.amount}`;

      if (
        seen.has(
          key,
        )
      ) {
        return false;
      }

      seen.add(
        key,
      );

      return true;
    },
  );
}

export function toCsv(
  rows: UpiCredit[],
): string {
  return [
    "Date,UTR,Amount,Mode",

    ...rows.map(
      (r) =>
        `${r.date},${r.utr},${r.amount},${r.mode}`,
    ),
  ].join("\n");
}
