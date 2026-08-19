/* ========================================================================== *
 * UNIVERSAL INDIAN BANK STATEMENT CORE — V3.1
 *
 * One shared engine for PDF text/OCR, XLS/XLSX, CSV and TXT.
 * Direction is determined independently from payment mode.
 *
 * V3.1 targeted additions:
 * - Safe standalone "Type" header detection for Amount + Type bank exports.
 * - Explicit Type=CR/DR support without changing existing Debit/Credit priority.
 * - Guarded UPI/CR and UPI/DR recovery when malformed exports leave amount
 *   outside the normal dedicated-column path.
 * ========================================================================== */

export type Row = string[];
export type Direction = "credit" | "debit" | "unknown";
export type PaymentMode = "UPI" | "IMPS" | "NEFT" | "RTGS" | "OTHER";
export type Confidence = "high" | "medium" | "low";
export type StatementOrder = "ascending" | "descending" | "unknown";

export type ColumnMap = {
  serial?: number;
  date?: number;
  valueDate?: number;
  narration?: number;
  reference?: number;
  debit?: number;
  credit?: number;
  amount?: number;
  type?: number;
  balance?: number;
  balanceType?: number;
  channel?: number;
};

export type CoreTransaction = {
  date: string;
  rawDate: string;
  narration: string;
  reference: string | null;
  amount: number | null;
  direction: Direction;
  mode: PaymentMode;
  balance: number | null;
  confidence: Confidence;
  raw: string;
  rowIndex: number;
  reasons: string[];
};

export type StatementSummary = {
  transactionCount?: number;
  debitCount?: number;
  creditCount?: number;
  debitAmount?: number;
  creditAmount?: number;
  openingBalance?: number;
  closingBalance?: number;
};

export type CoreResult = {
  transactions: CoreTransaction[];
  columns: ColumnMap | null;
  summary: StatementSummary | null;
  warnings: string[];
};

/* -------------------------------------------------------------------------- *
 * Normalization
 * -------------------------------------------------------------------------- */

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[‐-‒–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactText(value: unknown): string {
  return normalizeText(value).replace(/\s*([/:_=\-])\s*/g, "$1");
}

function rowText(row: Row): string {
  return normalizeText(row.join(" "));
}

/* -------------------------------------------------------------------------- *
 * Date
 * -------------------------------------------------------------------------- */

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

function pad2(value: string): string {
  return value.padStart(2, "0");
}

function normalizeYear(value: string): string {
  if (value.length === 4) return value;
  return Number(value) >= 70 ? `19${value}` : `20${value}`;
}

export function excelSerialToDate(value: string): string | null {
  const input = value.trim();

  if (!/^\d+(?:\.0+)?$/.test(input)) return null;

  const serial = Number(input);

  if (serial < 36526 || serial > 73050) return null;

  const date = new Date(
    Math.round((serial - 25569) * 86400 * 1000),
  );

  if (Number.isNaN(date.getTime())) return null;

  return `${pad2(String(date.getUTCDate()))}/${pad2(
    String(date.getUTCMonth() + 1),
  )}/${date.getUTCFullYear()}`;
}

export function extractDate(input: string): string | null {
  const text = normalizeText(input);

  if (!text) return null;

  const excel = excelSerialToDate(text);

  if (excel) return excel;

  let m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(text);

  if (m) {
    return `${pad2(m[1] ?? "")}/${pad2(m[2] ?? "")}/${m[3] ?? ""}`;
  }

  m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text);

  if (m) {
    return `${pad2(m[3] ?? "")}/${pad2(m[2] ?? "")}/${m[1] ?? ""}`;
  }

  m = /\b(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})\b/.exec(text);

  if (m) {
    const month = MONTHS[(m[2] ?? "").slice(0, 3).toLowerCase()];

    if (month) {
      return `${pad2(m[1] ?? "")}/${month}/${normalizeYear(
        m[3] ?? "",
      )}`;
    }
  }

  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/.exec(text);

  if (m) {
    return `${pad2(m[1] ?? "")}/${pad2(m[2] ?? "")}/${normalizeYear(
      m[3] ?? "",
    )}`;
  }

  return null;
}

function dateTimeKey(input: string): number | null {
  const date = extractDate(input);

  if (!date) return null;

  const [dd, mm, yyyy] = date.split("/").map(Number);

  if (!dd || !mm || !yyyy) return null;

  const tm = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/.exec(input);

  const hh = Number(tm?.[1] ?? 0);
  const min = Number(tm?.[2] ?? 0);
  const sec = Number(tm?.[3] ?? 0);

  return Date.UTC(
    yyyy,
    mm - 1,
    dd,
    hh,
    min,
    sec,
  );
}

/* -------------------------------------------------------------------------- *
 * Money
 * -------------------------------------------------------------------------- */

export function parseMoney(input: unknown): number | null {
  const original = normalizeText(input);

  if (!original || original === "-" || original === "--") {
    return null;
  }

  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(original)) {
    return null;
  }

  if (
    /[-/.]/.test(original) &&
    extractDate(original) !== null
  ) {
    return null;
  }

  const negativeByBrackets = /^\(.*\)$/.test(original);

  const cleaned = original
    .replace(/₹/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .replace(/[()]/g, "")
    .replace(/(?:CR|DR)$/i, "");

  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }

  let n = Number(cleaned);

  if (!Number.isFinite(n)) {
    return null;
  }

  if (negativeByBrackets) {
    n = -Math.abs(n);
  }

  return n;
}

function moneyTokens(input: string): number[] {
  const text = normalizeText(input)
    .replace(
      /\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/g,
      " ",
    )
    .replace(
      /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
      " ",
    );

  const out: number[] = [];

  const re =
    /(?:₹\s*)?(\(?[+-]?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?\)?)/g;

  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? "";

    const plain = raw.replace(/[(),₹+\-]/g, "");

    if (
      /^\d{7,}$/.test(plain) &&
      !raw.includes(",") &&
      !raw.includes(".")
    ) {
      continue;
    }

    const n = parseMoney(raw);

    if (n !== null) {
      out.push(n);
    }
  }

  return out;
}

function compoundMoney(
  input: string,
): {
  first: number | null;
  second: number | null;
} {
  const v = moneyTokens(input);

  return {
    first: v[0] ?? null,
    second: v[1] ?? null,
  };
}

/* -------------------------------------------------------------------------- *
 * Header / columns
 * -------------------------------------------------------------------------- */

const DATE_H =
  /\b(transaction\s*date|tran\.?\s*date|txn\s*date|posting\s*date|post\s*date|date)\b/i;

const VALUE_DATE_H =
  /\b(value\s*date|effective\s*date)\b/i;

const NARR_H =
  /\b(particulars?|narration|description|remarks?|details?|transaction\s*details?|transaction\s*description|account\s*description)\b/i;

const REF_H =
  /\b(chq\s*\/?\s*ref(?:erence)?\s*(?:no)?|cheque\s*\/?\s*reference|cheque\s*no|reference\s*(?:no|number)?|ref\.?\s*no|utr|rrn|transaction\s*id|txn\s*id|instrument\s*(?:id|no)|inst\.?\s*no)\b/i;

const DEBIT_H =
  /\b(debit\s*amount|debit|dr\.?\s*amount|withdrawal|withdrawals|withdraw|withdrawn)\b/i;

const CREDIT_H =
  /\b(credit\s*amount|credit|cr\.?\s*amount|deposit|deposits|deposited)\b/i;

const TYPE_H =
  /\b(debit\s*\/\s*credit|credit\s*\/\s*debit|dr\s*\/\s*cr|cr\s*\/\s*dr|transaction\s*type|txn\s*type|indicator)\b/i;

const GENERIC_TYPE_H =
  /^(?:type|dr\s*cr|cr\s*dr|debit\s*credit|credit\s*debit)$/i;

const BAL_H =
  /\b(closing\s*balance|running\s*balance|available\s*balance|balance\s*\(inr\)|balance)\b/i;

const AMOUNT_H =
  /\b(transaction\s*amount|txn\s*amount|amount\s*\(inr\)|amount)\b/i;

const CHANNEL_H =
  /\b(channel|mode|transaction\s*channel)\b/i;

const SERIAL_H =
  /^(s\.?\s*no\.?|sr\.?\s*no\.?|serial|sl\.?\s*no\.?)$/i;

export function detectColumns(
  header: Row,
): ColumnMap | null {
  if (header.length < 2) {
    return null;
  }

  const normalizedHeader = header.map(
    (cell) =>
      normalizeText(cell)
        .toLowerCase()
        .replace(/[.:]+/g, " "),
  );

  const headerContext = normalizedHeader.join(" ");

  const genericTypeAllowed =
    DATE_H.test(headerContext) &&
    (
      AMOUNT_H.test(headerContext) ||
      BAL_H.test(headerContext)
    );

  const map: ColumnMap = {};

  let evidence = 0;

  normalizedHeader.forEach(
    (
      text,
      index,
    ) => {
      if (
        !text ||
        text.length > 120
      ) {
        return;
      }

      if (SERIAL_H.test(text)) {
        map.serial ??= index;
        return;
      }

      if (VALUE_DATE_H.test(text)) {
        if (map.valueDate === undefined) {
          map.valueDate = index;
          evidence++;
        }

        return;
      }

      if (DATE_H.test(text)) {
        if (map.date === undefined) {
          map.date = index;
          evidence++;
        }

        return;
      }

      if (NARR_H.test(text)) {
        if (map.narration === undefined) {
          map.narration = index;
          evidence++;
        }

        return;
      }

      if (REF_H.test(text)) {
        if (map.reference === undefined) {
          map.reference = index;
          evidence++;
        }

        return;
      }

      if (
        BAL_H.test(text) &&
        /\b(?:dr|cr)\b/i.test(text)
      ) {
        map.balanceType ??= index;
        return;
      }

      if (BAL_H.test(text)) {
        if (map.balance === undefined) {
          map.balance = index;
          evidence++;
        }

        return;
      }

      if (CHANNEL_H.test(text)) {
        map.channel ??= index;
        return;
      }

      if (
        TYPE_H.test(text) ||
        (
          genericTypeAllowed &&
          GENERIC_TYPE_H.test(text)
        ) ||
        (
          DEBIT_H.test(text) &&
          CREDIT_H.test(text)
        )
      ) {
        if (map.type === undefined) {
          map.type = index;
          evidence++;
        }

        return;
      }

      if (DEBIT_H.test(text)) {
        if (map.debit === undefined) {
          map.debit = index;
          evidence++;
        }

        return;
      }

      if (CREDIT_H.test(text)) {
        if (map.credit === undefined) {
          map.credit = index;
          evidence++;
        }

        return;
      }

      if (AMOUNT_H.test(text)) {
        if (map.amount === undefined) {
          map.amount = index;
          evidence++;
        }
      }
    },
  );

  return evidence >= 2
    ? map
    : null;
}

function columnScore(
  map: ColumnMap,
): number {
  let s = 0;

  if (map.date !== undefined) s += 5;
  if (map.narration !== undefined) s += 5;
  if (map.debit !== undefined) s += 5;
  if (map.credit !== undefined) s += 5;
  if (map.amount !== undefined) s += 4;
  if (map.type !== undefined) s += 4;
  if (map.balance !== undefined) s += 3;
  if (map.reference !== undefined) s += 2;

  return s;
}

export function findColumns(
  rows: Row[],
): {
  columns: ColumnMap | null;
  headerIndex: number;
  headerDepth: number;
} {
  const max = Math.min(
    rows.length,
    100,
  );

  let best:
    {
      columns: ColumnMap;
      headerIndex: number;
      headerDepth: number;
      score: number;
    } | null =
    null;

  for (
    let i = 0;
    i < max;
    i++
  ) {
    const first = rows[i] ?? [];

    const candidates:
      Array<{
        row: Row;
        depth: number;
      }> = [
        {
          row: first,
          depth: 1,
        },
      ];

    const second = rows[i + 1];

    if (second) {
      const width = Math.max(
        first.length,
        second.length,
      );

      const combined: Row = [];

      for (
        let c = 0;
        c < width;
        c++
      ) {
        combined[c] = normalizeText(
          `${first[c] ?? ""} ${second[c] ?? ""}`,
        );
      }

      candidates.push({
        row: combined,
        depth: 2,
      });
    }

    for (const candidate of candidates) {
      const columns = detectColumns(
        candidate.row,
      );

      if (!columns) {
        continue;
      }

      const score = columnScore(
        columns,
      );

      if (
        !best ||
        score > best.score
      ) {
        best = {
          columns,
          headerIndex: i,
          headerDepth: candidate.depth,
          score,
        };
      }
    }
  }

  return best
    ? {
        columns: best.columns,
        headerIndex: best.headerIndex,
        headerDepth: best.headerDepth,
      }
    : {
        columns: null,
        headerIndex: -1,
        headerDepth: 0,
      };
}

function inferOcrColumns(
  rows: Row[],
): ColumnMap | null {
  const samples = rows
    .filter(
      (r) =>
        r.length >= 6 &&
        extractDate(
          r[0] ?? "",
        ) !== null,
    )
    .slice(
      0,
      10,
    );

  if (!samples.length) {
    return null;
  }

  if (
    !samples.some(
      (r) =>
        parseMoney(
          r[3] ?? "",
        ) !== null ||
        parseMoney(
          r[4] ?? "",
        ) !== null ||
        parseMoney(
          r[5] ?? "",
        ) !== null,
    )
  ) {
    return null;
  }

  return {
    date: 0,
    narration: 1,
    reference: 2,
    debit: 3,
    credit: 4,
    balance: 5,
  };
}

/* -------------------------------------------------------------------------- *
 * Row reconstruction
 * -------------------------------------------------------------------------- */

function rowHasDate(
  row: Row,
): boolean {
  return row.some(
    (cell) =>
      extractDate(
        cell,
      ) !== null,
  );
}

function isNoise(
  row: Row,
): boolean {
  const text = rowText(
    row,
  );

  if (
    !text ||
    rowHasDate(row)
  ) {
    return !text;
  }

  return (
    /\b(account\s*(?:no|number)|customer\s*(?:id|name|number)|branch\s*(?:name|code|address)|ifsc|micr|statement\s*(?:of\s*account)?|nominee|currency|registered\s*mobile|registered\s*email)\b/i.test(
      text,
    ) ||
    /^page\s+\d+(?:\s+of\s+\d+)?$/i.test(
      text,
    ) ||
    /^total\s+(?:debit|credit|transaction)/i.test(
      text,
    ) ||
    /^opening\s+balance/i.test(
      text,
    ) ||
    /^closing\s+balance/i.test(
      text,
    )
  );
}

export function reconstructRows(
  rows: Row[],
  startIndex = 0,
): Row[] {
  const out: Row[] = [];

  let current: Row | null = null;

  for (
    let i = Math.max(
      0,
      startIndex,
    );
    i < rows.length;
    i++
  ) {
    const row = (
      rows[i] ?? []
    ).map(
      normalizeText,
    );

    if (
      !row.some(
        Boolean,
      )
    ) {
      continue;
    }

    if (
      detectColumns(
        row,
      )
    ) {
      if (current) {
        out.push(
          current,
        );
      }

      current = null;

      continue;
    }

    if (
      isNoise(
        row,
      )
    ) {
      continue;
    }

    if (
      rowHasDate(
        row,
      )
    ) {
      if (current) {
        out.push(
          current,
        );
      }

      current = [
        ...row,
      ];

      continue;
    }

    if (!current) {
      continue;
    }

    if (
      current.length === 1 &&
      row.length === 1
    ) {
      current[0] = normalizeText(
        `${current[0] ?? ""} ${row[0] ?? ""}`,
      );
    } else {
      const width = Math.max(
        current.length,
        row.length,
      );

      for (
        let c = 0;
        c < width;
        c++
      ) {
        const extra = row[c] ?? "";

        if (extra) {
          current[c] = normalizeText(
            `${current[c] ?? ""} ${extra}`,
          );
        }
      }
    }
  }

  if (current) {
    out.push(
      current,
    );
  }

  return out;
}

function detectStatementOrder(
  rows: Row[],
  columns: ColumnMap | null,
): StatementOrder {
  const keys: number[] = [];

  for (const row of rows) {
    const source =
      columns?.date !== undefined
        ? (
            row[
              columns.date
            ] ?? ""
          )
        : rowText(
            row,
          );

    const key = dateTimeKey(
      source,
    );

    if (
      key !== null
    ) {
      keys.push(
        key,
      );
    }
  }

  for (
    let i = 1;
    i < keys.length;
    i++
  ) {
    const a = keys[i - 1];
    const b = keys[i];

    if (
      a === undefined ||
      b === undefined ||
      a === b
    ) {
      continue;
    }

    return b > a
      ? "ascending"
      : "descending";
  }

  return "unknown";
}

/* -------------------------------------------------------------------------- *
 * Direction / mode
 * -------------------------------------------------------------------------- */

function indicatorDirection(
  input: string,
): Direction {
  const v = normalizeText(
    input,
  )
    .replace(
      /\./g,
      "",
    )
    .toUpperCase();

  if (
    /^(CR|C|CREDIT|CREDITED|DEPOSIT)$/.test(
      v,
    )
  ) {
    return "credit";
  }

  if (
    /^(DR|D|DEBIT|DEBITED|WITHDRAW|WITHDRAWAL)$/.test(
      v,
    )
  ) {
    return "debit";
  }

  return "unknown";
}

function flatIndicatorDirection(
  input: string,
): Direction {
  const text = normalizeText(
    input,
  ).replace(
    /\s+(?:CR|DR)\s*$/i,
    "",
  );

  const matches = [
    ...text.matchAll(
      /(?:^|\s|[/|])((?:CR|DR)|CREDIT|DEBIT)(?=\s|[/|]|$)/gi,
    ),
  ];

  for (const m of matches) {
    const d = indicatorDirection(
      m[1] ?? "",
    );

    if (
      d !== "unknown"
    ) {
      return d;
    }
  }

  return "unknown";
}

function narrationDirection(
  input: string,
): Direction {
  const text = compactText(
    input,
  );

  if (
    /(?:^|[/_: -])UPI[/_: -]+CR(?:[/_: -]|$)/i.test(
      text,
    )
  ) {
    return "credit";
  }

  if (
    /(?:^|[/_: -])UPI[/_: -]+DR(?:[/_: -]|$)/i.test(
      text,
    )
  ) {
    return "debit";
  }

  if (
    /\b(?:credited|amount credited|credit received|amount received|deposited)\b/i.test(
      text,
    )
  ) {
    return "credit";
  }

  if (
    /\b(?:debited|amount debited|withdrawn)\b/i.test(
      text,
    )
  ) {
    return "debit";
  }

  return "unknown";
}

function explicitUpiDirection(
  input: string,
): Direction {
  const text = compactText(
    input,
  );

  if (
    /(?:^|[/_: -])UPI[/_: -]+CR(?:[/_: -]|$)/i.test(
      text,
    )
  ) {
    return "credit";
  }

  if (
    /(?:^|[/_: -])UPI[/_: -]+DR(?:[/_: -]|$)/i.test(
      text,
    )
  ) {
    return "debit";
  }

  return "unknown";
}

export function detectMode(
  input: string,
): PaymentMode {
  const text = compactText(
    input,
  );

  if (
    /\b(?:IBRTGS|ERTGS|RTGS)\b/i.test(
      text,
    )
  ) {
    return "RTGS";
  }

  if (
    /\b(?:IBNEFT|ENEFT|NEFT)\b/i.test(
      text,
    )
  ) {
    return "NEFT";
  }

  if (
    /\bIMPS\b/i.test(
      text,
    ) ||
    /(?:^|[/_: -])P2A(?:[/_: -]|$)/i.test(
      text,
    ) ||
    /\b(?:PSP2A|IMPSP2A)\b/i.test(
      text,
    )
  ) {
    return "IMPS";
  }

  if (
    /\bUPI\b/i.test(
      text,
    ) ||
    /\bBHIM\b/i.test(
      text,
    ) ||
    /\bMPAY\/UPI\b/i.test(
      text,
    ) ||
    /\bTRTR\b/i.test(
      text,
    )
  ) {
    return "UPI";
  }

  return "OTHER";
}

/* -------------------------------------------------------------------------- *
 * References
 * -------------------------------------------------------------------------- */

type RefCandidate = {
  value: string;
  score: number;
};

function cleanReference(
  input: string,
): string {
  return normalizeText(
    input,
  )
    .replace(
      /^[\s:;,.()[\]{}<>|]+/,
      "",
    )
    .replace(
      /[\s:;,.()[\]{}<>|]+$/,
      "",
    )
    .replace(
      /^[-_/]+/,
      "",
    )
    .replace(
      /[-_/]+$/,
      "",
    );
}

function usableReference(
  input: string,
): boolean {
  const value = cleanReference(
    input,
  );

  const compact = value.replace(
    /[-_/]/g,
    "",
  );

  if (
    compact.length < 6 ||
    compact.length > 50 ||
    !/\d/.test(compact)
  ) {
    return false;
  }

  if (
    /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(
      value,
    )
  ) {
    return false;
  }

  if (
    /^[6-9]\d{9}$/.test(
      value,
    )
  ) {
    return false;
  }

  if (
    extractDate(
      value,
    ) !== null
  ) {
    return false;
  }

  if (
    /[.,₹]/.test(
      value,
    ) &&
    parseMoney(
      value,
    ) !== null
  ) {
    return false;
  }

  return true;
}

function addRef(
  out: RefCandidate[],
  raw: string | undefined,
  score: number,
): void {
  if (!raw) {
    return;
  }

  const value = cleanReference(
    raw,
  );

  if (
    usableReference(
      value,
    )
  ) {
    out.push({
      value,
      score,
    });
  }
}

function regexRefs(
  text: string,
  mode: PaymentMode,
): RefCandidate[] {
  const out: RefCandidate[] = [];

  const compact = compactText(
    text,
  );

  const explicitPatterns:
    Array<
      [
        RegExp,
        number,
      ]
    > = [
      [
        /\bX?UTR[\s:/=_-]+([A-Z0-9][A-Z0-9/_-]{5,48})/gi,
        500,
      ],
      [
        /\bRRN[\s:/=_-]+(\d{10,18})/gi,
        490,
      ],
      [
        /\bREF(?:ERENCE)?(?:\s*(?:NO|NUMBER))?[\s:/=_-]+([A-Z0-9][A-Z0-9/_-]{5,48})/gi,
        360,
      ],
      [
        /\b(?:TXN|TRANSACTION)\s*(?:ID|REF(?:ERENCE)?)[\s:/=_-]+([A-Z0-9][A-Z0-9/_-]{5,48})/gi,
        350,
      ],
    ];

  for (
    const [
      re,
      score,
    ] of explicitPatterns
  ) {
    let m:
      RegExpExecArray | null;

    while (
      (
        m = re.exec(
          text,
        )
      ) !== null
    ) {
      addRef(
        out,
        m[1],
        score,
      );
    }
  }

  const collect = (
    re: RegExp,
    score: number,
  ) => {
    let m:
      RegExpExecArray | null;

    while (
      (
        m = re.exec(
          compact,
        )
      ) !== null
    ) {
      addRef(
        out,
        m[1],
        score,
      );
    }
  };

  if (
    mode === "UPI"
  ) {
    collect(
      /\bUPI\/RRN\/?(\d{12})(?!\d)/gi,
      480,
    );

    collect(
      /\bUPI\/(?:CR\/|DR\/)?(\d{12})(?!\d)/gi,
      470,
    );

    collect(
      /\bMPAY\/UPI\/(?:TRTR\/)?(\d{12})(?!\d)/gi,
      480,
    );

    collect(
      /\bTRTR\/(\d{12})(?!\d)/gi,
      470,
    );
  } else if (
    mode === "IMPS"
  ) {
    collect(
      /\bIMPS\/(?:P2A\/|P2P\/)?(\d{10,18})(?!\d)/gi,
      460,
    );

    collect(
      /\bPS\/?P2A\/?(\d{10,18})(?!\d)/gi,
      450,
    );

    collect(
      /\bPSP2A(\d{10,18})(?!\d)/gi,
      450,
    );

    collect(
      /\bIMPSP2A(\d{10,18})(?!\d)/gi,
      450,
    );

    collect(
      /\bIMPS[_/-]\d{8}[_/-](\d{10,18})(?:[_/-]|$)/gi,
      440,
    );
  } else if (
    mode === "NEFT"
  ) {
    collect(
      /\b(?:IBNEFT|ENEFT|NEFT)[/:=_-]+([A-Z0-9]{8,40})(?=$|[-/:\s])/gi,
      450,
    );

    collect(
      /\b([A-Z]{4,8}[A-Z0-9]*\d[A-Z0-9]{8,32})\b/gi,
      360,
    );
  } else if (
    mode === "RTGS"
  ) {
    collect(
      /\b(?:IBRTGS|ERTGS|RTGS)[/:=_-]+([A-Z0-9]{8,40})(?=$|[-/:\s])/gi,
      450,
    );

    collect(
      /\b([A-Z]{4,8}R[A-Z0-9]{8,32})\b/gi,
      380,
    );

    collect(
      /\b([A-Z]{4,8}[A-Z0-9]*\d[A-Z0-9]{8,32})\b/gi,
      350,
    );
  }

  if (
    mode === "UPI"
  ) {
    for (
      const m of text.matchAll(
        /(?<!\d)(\d{12})(?!\d)/g,
      )
    ) {
      addRef(
        out,
        m[1],
        190,
      );
    }
  }

  return out;
}

export function extractReference(
  row: Row,
  columns: ColumnMap | null,
  mode: PaymentMode,
): string | null {
  const candidates: RefCandidate[] = [];

  if (
    columns?.reference !== undefined
  ) {
    const cell =
      row[
        columns.reference
      ] ?? "";

    candidates.push(
      ...regexRefs(
        cell,
        mode,
      ),
    );

    addRef(
      candidates,
      cell,
      cleanReference(
        cell,
      ).length <= 9
        ? 210
        : 300,
    );
  }

  candidates.push(
    ...regexRefs(
      rowText(
        row,
      ),
      mode,
    ),
  );

  const best = new Map<
    string,
    number
  >();

  for (const c of candidates) {
    const key = c.value.toUpperCase();

    const old = best.get(
      key,
    );

    if (
      old === undefined ||
      c.score > old
    ) {
      best.set(
        key,
        c.score,
      );
    }
  }

  return (
    [...best.entries()]
      .sort(
        (
          a,
          b,
        ) =>
          b[1] - a[1],
      )[0]?.[0] ??
    null
  );
}

/* -------------------------------------------------------------------------- *
 * Amount / balance / classification
 * -------------------------------------------------------------------------- */

function cellMoney(
  row: Row,
  index: number | undefined,
): number | null {
  return index === undefined
    ? null
    : parseMoney(
        row[index] ?? "",
      );
}

function extractBalance(
  row: Row,
  columns: ColumnMap | null,
): number | null {
  const direct = cellMoney(
    row,
    columns?.balance,
  );

  if (
    direct !== null
  ) {
    return Math.abs(
      direct,
    );
  }

  for (
    const index of [
      columns?.debit,
      columns?.credit,
      columns?.amount,
    ]
  ) {
    if (
      index === undefined
    ) {
      continue;
    }

    const c = compoundMoney(
      row[index] ?? "",
    );

    if (
      c.second !== null
    ) {
      return Math.abs(
        c.second,
      );
    }
  }

  if (
    row.length === 1
  ) {
    const vals = moneyTokens(
      row[0] ?? "",
    );

    if (
      vals.length >= 2
    ) {
      return Math.abs(
        vals[
          vals.length - 1
        ] ?? 0,
      );
    }
  }

  return null;
}

function flatAmount(
  row: Row,
): number | null {
  if (
    row.length !== 1
  ) {
    return null;
  }

  const vals = moneyTokens(
    row[0] ?? "",
  );

  return vals.length >= 2
    ? (
        vals[
          vals.length - 2
        ] ?? null
      )
    : (
        vals[0] ?? null
      );
}

function structuredAmount(
  row: Row,
  columns: ColumnMap | null,
): number | null {
  const direct = cellMoney(
    row,
    columns?.amount,
  );

  if (
    direct !== null
  ) {
    return direct;
  }

  const candidates: number[] = [];

  row.forEach(
    (
      cell,
      index,
    ) => {
      if (
        index === columns?.date ||
        index === columns?.valueDate ||
        index === columns?.reference ||
        index === columns?.balance ||
        index === columns?.balanceType ||
        index === columns?.serial ||
        index === columns?.type
      ) {
        return;
      }

      const n = parseMoney(
        cell,
      );

      if (
        n !== null
      ) {
        candidates.push(
          n,
        );
      }
    },
  );

  return (
    candidates[0] ??
    null
  );
}

function explicitUpiAmount(
  row: Row,
  columns: ColumnMap | null,
  direction: Direction,
): number | null {
  const preferredIndex =
    direction === "credit"
      ? columns?.credit
      : direction === "debit"
        ? columns?.debit
        : undefined;

  if (
    preferredIndex !== undefined
  ) {
    const compound = compoundMoney(
      row[
        preferredIndex
      ] ?? "",
    );

    if (
      compound.first !== null
    ) {
      return Math.abs(
        compound.first,
      );
    }
  }

  if (
    columns?.amount !== undefined
  ) {
    const amountCompound = compoundMoney(
      row[
        columns.amount
      ] ?? "",
    );

    if (
      amountCompound.first !== null
    ) {
      return Math.abs(
        amountCompound.first,
      );
    }
  }

  if (
    row.length === 1
  ) {
    const vals = moneyTokens(
      row[0] ?? "",
    );

    if (
      vals.length >= 2
    ) {
      return Math.abs(
        vals[
          vals.length - 2
        ] ?? 0,
      );
    }

    if (
      vals.length === 1
    ) {
      return Math.abs(
        vals[0] ?? 0,
      );
    }
  }

  for (
    let index = 0;
    index < row.length;
    index++
  ) {
    if (
      index === columns?.date ||
      index === columns?.valueDate ||
      index === columns?.reference ||
      index === columns?.balance ||
      index === columns?.balanceType ||
      index === columns?.serial ||
      index === columns?.type
    ) {
      continue;
    }

    const c = compoundMoney(
      row[index] ?? "",
    );

    if (
      c.first !== null
    ) {
      return Math.abs(
        c.first,
      );
    }
  }

  return null;
}

type Facts = {
  row: Row;
  rowIndex: number;
  raw: string;
  date: string;
  rawDate: string;
  narration: string;
  mode: PaymentMode;
  reference: string | null;
  balance: number | null;
  amountCandidate: number | null;
};

function classify(
  f: Facts,
  columns: ColumnMap | null,
  comparisonBalance: number | null,
): {
  direction: Direction;
  amount: number | null;
  reasons: string[];
} {
  const reasons: string[] = [];

  const row = f.row;

  /*
   * 1. Existing authoritative dedicated Debit / Credit columns.
   * Kept first to preserve old working-bank behavior.
   */
  if (
    columns?.debit !== undefined ||
    columns?.credit !== undefined
  ) {
    const debit =
      columns.debit === undefined
        ? null
        : compoundMoney(
            row[
              columns.debit
            ] ?? "",
          ).first;

    const credit =
      columns.credit === undefined
        ? null
        : compoundMoney(
            row[
              columns.credit
            ] ?? "",
          ).first;

    if (
      debit !== null &&
      Math.abs(
        debit,
      ) > 0 &&
      (
        credit === null ||
        Math.abs(
          credit,
        ) === 0
      )
    ) {
      return {
        direction: "debit",
        amount: Math.abs(
          debit,
        ),
        reasons: [
          "dedicated debit column",
        ],
      };
    }

    if (
      credit !== null &&
      Math.abs(
        credit,
      ) > 0 &&
      (
        debit === null ||
        Math.abs(
          debit,
        ) === 0
      )
    ) {
      return {
        direction: "credit",
        amount: Math.abs(
          credit,
        ),
        reasons: [
          "dedicated credit column",
        ],
      };
    }
  }

  /*
   * 2. Explicit transaction Type / DR / CR column.
   */
  if (
    columns?.type !== undefined
  ) {
    const d = indicatorDirection(
      row[
        columns.type
      ] ?? "",
    );

    const amount = structuredAmount(
      row,
      columns,
    );

    if (
      d !== "unknown" &&
      amount !== null
    ) {
      return {
        direction: d,
        amount: Math.abs(
          amount,
        ),
        reasons: [
          "explicit transaction DR/CR",
        ],
      };
    }
  }

  let amount = structuredAmount(
    row,
    columns,
  );

  if (
    amount === null
  ) {
    amount = f.amountCandidate;
  }

  /*
   * 3. Guarded explicit UPI recovery.
   */
  const upiDirection = explicitUpiDirection(
    f.narration,
  );

  if (
    upiDirection !== "unknown"
  ) {
    const upiAmount =
      amount !== null
        ? Math.abs(
            amount,
          )
        : explicitUpiAmount(
            row,
            columns,
            upiDirection,
          );

    if (
      upiAmount !== null &&
      upiAmount > 0
    ) {
      return {
        direction: upiDirection,
        amount: upiAmount,
        reasons: [
          "explicit UPI CR/DR marker",
        ],
      };
    }
  }

  /*
   * 4. Existing standalone DR/CR in flattened/fixed text.
   */
  if (
    amount !== null
  ) {
    const d = flatIndicatorDirection(
      f.raw,
    );

    if (
      d !== "unknown"
    ) {
      return {
        direction: d,
        amount: Math.abs(
          amount,
        ),
        reasons: [
          "standalone transaction DR/CR",
        ],
      };
    }
  }

  /*
   * 5. Existing signed negative amount.
   */
  if (
    amount !== null &&
    amount < 0
  ) {
    return {
      direction: "debit",
      amount: Math.abs(
        amount,
      ),
      reasons: [
        "negative transaction amount",
      ],
    };
  }

  /*
   * 6. Existing running balance reconciliation.
   */
  if (
    amount !== null &&
    f.balance !== null &&
    comparisonBalance !== null
  ) {
    const delta = Number(
      (
        f.balance -
        comparisonBalance
      ).toFixed(
        2,
      ),
    );

    const diff = Math.abs(
      Math.abs(
        delta,
      ) -
        Math.abs(
          amount,
        ),
    );

    const tolerance = Math.max(
      0.02,
      Math.abs(
        amount,
      ) *
        0.00001,
    );

    if (
      Math.abs(
        delta,
      ) > 0 &&
      diff <= tolerance
    ) {
      return {
        direction:
          delta > 0
            ? "credit"
            : "debit",
        amount: Math.abs(
          amount,
        ),
        reasons: [
          "running balance reconciliation",
        ],
      };
    }
  }

  /*
   * 7. Existing strong narration fallback.
   */
  if (
    amount !== null
  ) {
    const d = narrationDirection(
      f.narration,
    );

    if (
      d !== "unknown"
    ) {
      return {
        direction: d,
        amount: Math.abs(
          amount,
        ),
        reasons: [
          "strong narration direction marker",
        ],
      };
    }
  }

  return {
    direction: "unknown",
    amount:
      amount === null
        ? null
        : Math.abs(
            amount,
          ),
    reasons,
  };
}

/* -------------------------------------------------------------------------- *
 * Summary / confidence
 * -------------------------------------------------------------------------- */

function summaryNumber(
  text: string,
  re: RegExp,
): number | undefined {
  const raw = re.exec(
    text,
  )?.[1];

  if (!raw) {
    return undefined;
  }

  const n = Number(
    raw.replace(
      /,/g,
      "",
    ),
  );

  return Number.isFinite(
    n,
  )
    ? n
    : undefined;
}

export function extractStatementSummary(
  rows: Row[],
): StatementSummary | null {
  const text = rows
    .map(
      rowText,
    )
    .join(
      "\n",
    );

  const s: StatementSummary = {};

  const put =
    <
      K extends keyof StatementSummary,
    >(
      key: K,
      value:
        | StatementSummary[K]
        | undefined,
    ) => {
      if (
        value !== undefined
      ) {
        s[key] = value;
      }
    };

  put(
    "transactionCount",
    summaryNumber(
      text,
      /total\s+transaction\s+count\s*[:=-]?\s*(\d+)/i,
    ),
  );

  put(
    "debitCount",
    summaryNumber(
      text,
      /total\s+debit\s+count\s*[:=-]?\s*(\d+)/i,
    ),
  );

  put(
    "creditCount",
    summaryNumber(
      text,
      /total\s+credit\s+count\s*[:=-]?\s*(\d+)/i,
    ),
  );

  put(
    "debitAmount",
    summaryNumber(
      text,
      /total\s+debit\s+amount\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ),
  );

  put(
    "creditAmount",
    summaryNumber(
      text,
      /total\s+credit\s+amount\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ),
  );

  put(
    "openingBalance",
    summaryNumber(
      text,
      /opening\s+balance\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ),
  );

  put(
    "closingBalance",
    summaryNumber(
      text,
      /closing\s+balance\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ),
  );

  return Object.keys(
    s,
  ).length
    ? s
    : null;
}

function confidenceFor(
  tx:
    Omit<
      CoreTransaction,
      | "confidence"
      | "raw"
      | "rawDate"
      | "rowIndex"
    >,
): Confidence {
  let score = 0;

  if (tx.date) {
    score += 2;
  }

  if (
    tx.amount !== null
  ) {
    score += 3;
  }

  if (
    tx.direction !== "unknown"
  ) {
    score += 4;
  }

  if (
    tx.mode !== "OTHER"
  ) {
    score += 2;
  }

  if (
    tx.reference
  ) {
    score += 2;
  }

  if (
    tx.reasons.some(
      (r) =>
        /dedicated|explicit|reconciliation|standalone/i.test(
          r,
        ),
    )
  ) {
    score += 2;
  }

  return score >= 11
    ? "high"
    : score >= 7
      ? "medium"
      : "low";
}

/* -------------------------------------------------------------------------- *
 * Main parser
 * -------------------------------------------------------------------------- */

export function parseStatementRows(
  inputRows: Row[],
  inheritedColumns: ColumnMap | null = null,
): CoreResult {
  const found = findColumns(
    inputRows,
  );

  const columns =
    found.columns ??
    inferOcrColumns(
      inputRows,
    ) ??
    inheritedColumns;

  const start =
    found.headerIndex >= 0
      ? found.headerIndex +
        Math.max(
          1,
          found.headerDepth,
        )
      : 0;

  const rebuilt = reconstructRows(
    inputRows,
    start,
  );

  const order = detectStatementOrder(
    rebuilt,
    columns,
  );

  const facts: Facts[] = [];

  for (
    let i = 0;
    i < rebuilt.length;
    i++
  ) {
    const row = rebuilt[i] ?? [];

    const raw = rowText(
      row,
    );

    const rawDate =
      columns?.date !== undefined
        ? normalizeText(
            row[
              columns.date
            ] ?? "",
          )
        : "";

    const date =
      extractDate(
        rawDate,
      ) ??
      row
        .map(
          extractDate,
        )
        .find(
          (
            v,
          ): v is string =>
            v !== null,
        ) ??
      extractDate(
        raw,
      );

    if (!date) {
      continue;
    }

    const narration =
      columns?.narration !== undefined &&
      normalizeText(
        row[
          columns.narration
        ] ?? "",
      )
        ? normalizeText(
            row[
              columns.narration
            ] ?? "",
          )
        : raw;

    let mode = detectMode(
      narration,
    );

    if (
      mode === "OTHER"
    ) {
      mode = detectMode(
        raw,
      );
    }

    facts.push({
      row,
      rowIndex: i,
      raw,
      date,
      rawDate:
        rawDate || date,
      narration,
      mode,

      reference: extractReference(
        row,
        columns,
        mode,
      ),

      balance: extractBalance(
        row,
        columns,
      ),

      amountCandidate:
        row.length === 1
          ? flatAmount(
              row,
            )
          : structuredAmount(
              row,
              columns,
            ),
    });
  }

  const transactions: CoreTransaction[] = [];

  for (
    let i = 0;
    i < facts.length;
    i++
  ) {
    const f = facts[i];

    if (!f) {
      continue;
    }

    let comparisonBalance: number | null = null;

    if (
      order === "ascending"
    ) {
      comparisonBalance =
        facts[
          i - 1
        ]?.balance ??
        null;
    } else if (
      order === "descending"
    ) {
      comparisonBalance =
        facts[
          i + 1
        ]?.balance ??
        null;
    }

    const c = classify(
      f,
      columns,
      comparisonBalance,
    );

    const partial = {
      date: f.date,
      narration: f.narration,
      reference: f.reference,
      amount: c.amount,
      direction: c.direction,
      mode: f.mode,
      balance: f.balance,
      reasons: c.reasons,
    };

    transactions.push({
      date: f.date,
      rawDate: f.rawDate,
      narration: f.narration,
      reference: f.reference,
      amount: c.amount,
      direction: c.direction,
      mode: f.mode,
      balance: f.balance,
      confidence: confidenceFor(
        partial,
      ),
      raw: f.raw,
      rowIndex: f.rowIndex,
      reasons: c.reasons,
    });
  }

  const warnings: string[] = [];

  const summary = extractStatementSummary(
    inputRows,
  );

  if (summary) {
    const debits = transactions.filter(
      (t) =>
        t.direction === "debit" &&
        t.amount !== null,
    );

    const credits = transactions.filter(
      (t) =>
        t.direction === "credit" &&
        t.amount !== null,
    );

    const debitTotal = debits.reduce(
      (
        s,
        t,
      ) =>
        s +
        (
          t.amount ??
          0
        ),
      0,
    );

    const creditTotal = credits.reduce(
      (
        s,
        t,
      ) =>
        s +
        (
          t.amount ??
          0
        ),
      0,
    );

    if (
      summary.debitCount !== undefined &&
      summary.debitCount !== debits.length
    ) {
      warnings.push(
        `Debit count mismatch: official=${summary.debitCount}, extracted=${debits.length}`,
      );
    }

    if (
      summary.creditCount !== undefined &&
      summary.creditCount !== credits.length
    ) {
      warnings.push(
        `Credit count mismatch: official=${summary.creditCount}, extracted=${credits.length}`,
      );
    }

    if (
      summary.debitAmount !== undefined &&
      Math.abs(
        summary.debitAmount -
          debitTotal,
      ) > 0.02
    ) {
      warnings.push(
        `Debit amount mismatch: official=${summary.debitAmount.toFixed(
          2,
        )}, extracted=${debitTotal.toFixed(
          2,
        )}`,
      );
    }

    if (
      summary.creditAmount !== undefined &&
      Math.abs(
        summary.creditAmount -
          creditTotal,
      ) > 0.02
    ) {
      warnings.push(
        `Credit amount mismatch: official=${summary.creditAmount.toFixed(
          2,
        )}, extracted=${creditTotal.toFixed(
          2,
        )}`,
      );
    }
  }

  return {
    transactions,
    columns,
    summary,
    warnings,
  };
}

/* -------------------------------------------------------------------------- *
 * Text adapters
 * -------------------------------------------------------------------------- */

export function textToRows(
  input: string,
): Row[] {
  return String(
    input ?? "",
  )
    .replace(
      /\r\n?/g,
      "\n",
    )
    .split(
      "\n",
    )
    .map(
      (raw) => {
        const line = raw.trim();

        if (!line) {
          return [];
        }

        if (
          (
            line.match(
              /\|/g,
            ) ?? []
          ).length >= 4
        ) {
          return line
            .split(
              "|",
            )
            .map(
              normalizeText,
            );
        }

        if (
          line.includes(
            "\t",
          )
        ) {
          return line
            .split(
              "\t",
            )
            .map(
              normalizeText,
            );
        }

        const fixed = line
          .split(
            /\s{2,}/,
          )
          .map(
            normalizeText,
          )
          .filter(
            Boolean,
          );

        return fixed.length >= 3
          ? fixed
          : [
              normalizeText(
                line,
              ),
            ];
      },
    )
    .filter(
      (row) =>
        row.some(
          Boolean,
        ),
    );
}

export function parseStatementText(
  text: string,
): CoreResult {
  return parseStatementRows(
    textToRows(
      text,
    ),
  );
}

/* -------------------------------------------------------------------------- *
 * Merge / dedupe
 * -------------------------------------------------------------------------- */

function transactionKey(
  tx: CoreTransaction,
): string {
  if (
    tx.reference
  ) {
    return [
      "REF",
      tx.reference,
      tx.direction,
      tx.mode,
      tx.amount?.toFixed(
        2,
      ) ?? "",
    ]
      .join(
        "|",
      )
      .toUpperCase();
  }

  return [
    "NOREF",
    tx.date,
    tx.direction,
    tx.mode,
    tx.amount?.toFixed(
      2,
    ) ?? "",
    tx.raw.slice(
      0,
      100,
    ),
  ]
    .join(
      "|",
    )
    .toUpperCase();
}

function quality(
  tx: CoreTransaction,
): number {
  let s = 0;

  if (
    tx.reference
  ) {
    s += 5;
  }

  if (
    tx.amount !== null
  ) {
    s += 5;
  }

  if (
    tx.direction !== "unknown"
  ) {
    s += 5;
  }

  if (
    tx.mode !== "OTHER"
  ) {
    s += 3;
  }

  if (
    tx.balance !== null
  ) {
    s += 2;
  }

  if (
    tx.confidence === "high"
  ) {
    s += 3;
  } else if (
    tx.confidence === "medium"
  ) {
    s += 1;
  }

  return s;
}

export function mergeCoreResults(
  results: CoreResult[],
): CoreResult {
  const map = new Map<
    string,
    CoreTransaction
  >();

  const warningSet = new Set<string>();

  let columns: ColumnMap | null = null;
  let summary: StatementSummary | null = null;

  for (const result of results) {
    if (
      columns === null &&
      result.columns !== null
    ) {
      columns = result.columns;
    }

    if (
      summary === null &&
      result.summary !== null
    ) {
      summary = result.summary;
    }

    result.warnings.forEach(
      (w) =>
        warningSet.add(
          w,
        ),
    );

    for (const tx of result.transactions) {
      const key = transactionKey(
        tx,
      );

      const old = map.get(
        key,
      );

      if (
        !old ||
        quality(
          tx,
        ) >
          quality(
            old,
          )
      ) {
        map.set(
          key,
          tx,
        );
      }
    }
  }

  return {
    transactions: [
      ...map.values(),
    ],
    columns,
    summary,
    warnings: [
      ...warningSet,
    ],
  };
}

/* -------------------------------------------------------------------------- *
 * Filters
 * -------------------------------------------------------------------------- */

export function isUpiCredit(
  tx: CoreTransaction,
): boolean {
  return (
    tx.direction === "credit" &&
    tx.mode === "UPI" &&
    tx.amount !== null
  );
}

export function isAnyDebit(
  tx: CoreTransaction,
): boolean {
  return (
    tx.direction === "debit" &&
    tx.amount !== null
  );
}

export function isPaymentDebit(
  tx: CoreTransaction,
): boolean {
  return (
    isAnyDebit(
      tx,
    ) &&
    (
      tx.mode === "UPI" ||
      tx.mode === "IMPS" ||
      tx.mode === "NEFT" ||
      tx.mode === "RTGS"
    )
  );
}

export function isOtherDebit(
  tx: CoreTransaction,
): boolean {
  return (
    isAnyDebit(
      tx,
    ) &&
    tx.mode === "OTHER"
  );
}

export function formatAmount(
  value: number,
): string {
  return Math.abs(
    value,
  ).toFixed(
    2,
  );
}
