/* ------------------------------------------------------------------ *
 * Universal DEBIT parser.
 *
 * Supported debit modes:
 * UPI
 * IMPS
 * NEFT
 * RTGS
 *
 * IMPORTANT:
 * Credit parser remains completely separate.
 *
 * A valid debit transaction must NOT disappear only because
 * the bank statement does not expose a usable UTR/reference.
 * In that case UTR = "N/A".
 * ------------------------------------------------------------------ */

import {
  detectColumns,
  extractDate,
  type ColumnMap,
  type Row,
} from "./upi-parser";

export type DebitMode =
  | "UPI"
  | "IMPS"
  | "NEFT"
  | "RTGS";

export type DebitTxn = {
  date: string;
  utr: string;
  amount: string;
  mode: DebitMode;
};

export type DebitResult = {
  rows: DebitTxn[];
};

/* ------------------------------------------------------------------ *
 * MODE DETECTION
 * ------------------------------------------------------------------ */

const MODE_PATTERNS: Array<{
  mode: DebitMode;
  re: RegExp;
}> = [
  {
    mode: "RTGS",
    re:
      /\b(rtgs|ibrtgs|ertgs)\b|(?:^|[\s/_:-])(rtgs|ibrtgs|ertgs)(?:$|[\s/_:-])/i,
  },

  {
    mode: "NEFT",
    re:
      /\b(neft|ibneft|eneft)\b|(?:^|[\s/_:-])(neft|ibneft|eneft)(?:$|[\s/_:-])/i,
  },

  {
    mode: "IMPS",
    re:
      /\bimps\b|imps[\s/_:-]|(?:^|[\s/_:-])ps[\s/_:-]*p2a(?:$|[\s/_:-])|(?:^|[\s/_:-])psp2a(?:$|[\s/_:-])|(?:^|[\s/_:-])impsp2a(?:$|[\s/_:-])|(?:^|[\s/_:-])p2a(?:$|[\s/_:-])/i,
  },

  {
    mode: "UPI",
    re:
      /\bupi\b|upi[\s/_:-]|\bbhim\b|\bmpay[\s/_:-]*upi\b|\bupi[\s/_:-]*rrn\b|\btrtr\b/i,
  },
];

const EXCLUDE_RE =
  /\b(atm|cash\s*wdl|cash\s*withdrawal|cheque|chq|clg|card\s*payment|pos\s|debit\s*card|credit\s*card|charges?|gst|interest|emi|ecs\b|ach\b|self\b)\b/i;

const DEBIT_WORDS =
  /\b(dr|debit|debits|debited|withdraw|withdrawal|withdrawals|withdrawn|sent|paid|payment|payments|transfer\s*out|outgoing|outward|out)\b/i;

const CREDIT_WORDS =
  /\b(cr|credit|credits|credited|deposit|deposits|received|incoming|inward)\b/i;

const BALANCE_WORDS =
  /\b(balance|bal|closing|running|available)\b/i;

const EXPLICIT_REF_RE =
  /\b(utr|xutr|rrn|upi\s*ref(?:erence)?|imps\s*ref(?:erence)?|neft\s*ref(?:erence)?|rtgs\s*ref(?:erence)?|ref(?:erence)?(?:\s*(?:no|num|number))?|txn\s*ref(?:erence)?|transaction\s*ref(?:erence)?|txn\s*id|transaction\s*id|trn|inst(?:rument)?\s*no)\b/i;

const BAD_REF_CONTEXT =
  /(a\/?c|acct|account|ben(?:eficiary)?|mobile|phone|ifsc|vpa|balance|bal\b|amount|amt|date|time|customer|cif)/i;

/* ------------------------------------------------------------------ *
 * AMOUNT
 * ------------------------------------------------------------------ */

const MONEY_RE =
  /(?<![\d.])(-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)(?!\d)/g;

function toNumber(
  value: string,
) {
  return Number(
    value.replace(/,/g, ""),
  );
}

function moneyTokens(
  text: string,
): string[] {
  const cleaned = text
    .replace(
      /\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}/g,
      " ",
    )

    .replace(
      /[A-Za-z]+[\d.,]+[A-Za-z]*|[\d.,]+[A-Za-z]+/g,
      " ",
    )

    .replace(
      /(?<!\d)\d{7,}(?!\d)/g,
      " ",
    );

  return cleaned.match(MONEY_RE) ?? [];
}

function cellAmount(
  cell: string,
): number | null {
  const tokens =
    moneyTokens(cell);

  if (!tokens.length) {
    return null;
  }

  const value =
    toNumber(
      tokens[0] ?? "",
    );

  return Number.isFinite(value)
    ? value
    : null;
}

function fmtAmount(
  value: number,
) {
  return Math.abs(value).toFixed(2);
}

/* ------------------------------------------------------------------ *
 * MODE
 * ------------------------------------------------------------------ */

export function detectMode(
  text: string,
): DebitMode | null {
  for (
    const {
      mode,
      re,
    } of MODE_PATTERNS
  ) {
    if (re.test(text)) {
      return mode;
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * REFERENCE ENGINE
 * ------------------------------------------------------------------ */

type CandidateSource =
  | "explicit"
  | "mode-pattern"
  | "numeric"
  | "token"
  | "bank-prefixed";

type Candidate = {
  value: string;
  index: number;
  source: CandidateSource;
  score: number;
};

function cleanRef(
  value: string,
): string {
  return value
    .trim()

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

function looksLikeIfsc(
  value: string,
) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(
    value,
  );
}

function looksLikeDate(
  value: string,
) {
  return /^\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(
    value,
  );
}

function looksLikeMoney(
  value: string,
) {
  return (
    /^-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?$/.test(
      value,
    ) ||
    /^-?\d+\.\d{1,2}$/.test(
      value,
    )
  );
}

function looksLikeMobile(
  value: string,
) {
  return /^[6-9]\d{9}$/.test(
    value,
  );
}

function looksLikeAccountNumber(
  value: string,
) {
  return /^\d{14,22}$/.test(
    value,
  );
}

function hasEnoughReferenceSignal(
  value: string,
) {
  const compact =
    value.replace(
      /[-_/]/g,
      "",
    );

  return (
    compact.length >= 8 &&
    compact.length <= 48 &&
    /\d/.test(compact)
  );
}

/* ------------------------------------------------------------------ *
 * Explicit references
 * ------------------------------------------------------------------ */

function explicitReferenceCandidates(
  text: string,
): Candidate[] {
  const results:
    Candidate[] = [];

  const re =
    /\b(UTR|XUTR|RRN|UPI\s*REF(?:ERENCE)?|IMPS\s*REF(?:ERENCE)?|NEFT\s*REF(?:ERENCE)?|RTGS\s*REF(?:ERENCE)?|REF(?:ERENCE)?(?:\s*(?:NO|NUM|NUMBER))?|TXN\s*REF(?:ERENCE)?|TRANSACTION\s*REF(?:ERENCE)?|TXN\s*ID|TRANSACTION\s*ID|TRN|INST(?:RUMENT)?\s*NO)\b[\s:#=\-\/]*([A-Z0-9][A-Z0-9_\/\-]{6,47})/gi;

  let match:
    RegExpExecArray | null;

  while (
    (match = re.exec(text)) !== null
  ) {
    const value =
      cleanRef(
        match[2] ?? "",
      );

    if (
      !value ||
      !hasEnoughReferenceSignal(
        value,
      )
    ) {
      continue;
    }

    const label =
      (
        match[1] ?? ""
      ).toUpperCase();

    let score = 170;

    if (
      label === "UTR" ||
      label === "XUTR"
    ) {
      score += 70;
    } else if (
      label === "RRN"
    ) {
      score += 60;
    } else if (
      /UPI|IMPS|NEFT|RTGS/.test(
        label,
      )
    ) {
      score += 50;
    } else if (
      /REF/.test(label)
    ) {
      score += 30;
    } else if (
      /ID|TRN|INST/.test(
        label,
      )
    ) {
      score += 20;
    }

    results.push({
      value,

      index:
        match.index +
        (
          match[0]?.lastIndexOf(
            match[2] ?? "",
          ) ?? 0
        ),

      source:
        "explicit",

      score,
    });
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * Mode-specific references
 * ------------------------------------------------------------------ */

function modeSpecificCandidates(
  text: string,
  mode: DebitMode,
): Candidate[] {
  const results:
    Candidate[] = [];

  const push =
    (
      re: RegExp,
      baseScore: number,
    ) => {
      let match:
        RegExpExecArray | null;

      while (
        (match =
          re.exec(text)) !== null
      ) {
        const raw =
          match[1] ?? "";

        const value =
          cleanRef(raw);

        if (
          !value ||
          !hasEnoughReferenceSignal(
            value,
          )
        ) {
          continue;
        }

        results.push({
          value,

          index:
            match.index +
            (
              match[0]?.lastIndexOf(
                raw,
              ) ?? 0
            ),

          source:
            "mode-pattern",

          score:
            baseScore,
        });
      }
    };

  /* ---------------- UPI ---------------- */

  if (
    mode === "UPI"
  ) {
    push(
      /\bUPI[\s/_:-]+RRN[\s/_:-]*([0-9]{12})(?!\d)/gi,
      200,
    );

    push(
      /\bUPI[\s/_:-]+(?:CR[\s/_:-]+|DR[\s/_:-]+)?([0-9]{12})(?!\d)/gi,
      180,
    );

    push(
      /\bMPAY[\s/_:-]+UPI[\s/_:-]+(?:TRTR[\s/_:-]+)?([0-9]{12})(?!\d)/gi,
      210,
    );

    push(
      /\bTRTR[\s/_:-]+([0-9]{12})(?!\d)/gi,
      190,
    );

    push(
      /\bBHIM[\s/_:-]+UPI[\s/_:-]+([0-9]{12})(?!\d)/gi,
      180,
    );
  }

  /* ---------------- IMPS ---------------- */

  if (
    mode === "IMPS"
  ) {
    push(
      /\bIMPS[\s/_:-]+(?:P2A[\s/_:-]+|P2P[\s/_:-]+)?([0-9]{10,18})(?!\d)/gi,
      205,
    );

    push(
      /\bPS[\s/_:-]*P2A[\s/_:-]+([0-9]{10,18})(?!\d)/gi,
      200,
    );

    push(
      /\bPSP2A([0-9]{10,18})(?!\d)/gi,
      200,
    );

    push(
      /\bIMPSP2A([0-9]{10,18})(?!\d)/gi,
      200,
    );
  }

  /* ---------------- NEFT ---------------- */

  if (
    mode === "NEFT"
  ) {
    /*
     * NEFT_OUT:PUNBN62025121456687398
     */
    push(
      /\bNEFT[\s_/-]*OUT[\s:/_-]+([A-Z0-9][A-Z0-9_-]{8,40})/gi,
      220,
    );

    /*
     * NEFT-BARBL26078306964
     * IBNEFT/...
     * eNEFT/...
     */
    push(
      /\b(?:IBNEFT|ENEFT|NEFT)[\s:/_-]+([A-Z0-9][A-Z0-9_-]{8,40})/gi,
      205,
    );

    /*
     * XUTR/AXNH261850049792
     */
    push(
      /\bXUTR[\s:/_-]+([A-Z0-9][A-Z0-9_-]{8,40})/gi,
      230,
    );

    /*
     * Generic bank-prefixed NEFT UTR.
     */
    push(
      /\b([A-Z]{3,8}[A-Z]?\d{8,30})\b/gi,
      120,
    );
  }

  /* ---------------- RTGS ---------------- */

  if (
    mode === "RTGS"
  ) {
    push(
      /\b(?:IBRTGS|ERTGS|RTGS)[\s:/_-]+([A-Z0-9][A-Z0-9_-]{8,44})/gi,
      215,
    );

    push(
      /\b([A-Z]{3,8}R\d{10,32})\b/gi,
      170,
    );

    push(
      /\b([A-Z]{4,8}\d{10,32})\b/gi,
      135,
    );
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * Generic candidates
 * ------------------------------------------------------------------ */

function genericCandidates(
  text: string,
): Candidate[] {
  const results:
    Candidate[] = [];

  /*
   * Numeric references.
   */
  const numeric =
    /(?<!\d)(\d{8,24})(?!\d)/g;

  let numberMatch:
    RegExpExecArray | null;

  while (
    (
      numberMatch =
        numeric.exec(text)
    ) !== null
  ) {
    const value =
      numberMatch[1] ?? "";

    results.push({
      value,

      index:
        numberMatch.index,

      source:
        "numeric",

      score:
        /^\d{12}$/.test(
          value,
        )
          ? 90
          : 35,
    });
  }

  /*
   * Alphanumeric reference.
   */
  const token =
    /(?<![A-Za-z0-9])([A-Za-z0-9][A-Za-z0-9_\/\-]{7,47})(?![A-Za-z0-9])/g;

  let tokenMatch:
    RegExpExecArray | null;

  while (
    (
      tokenMatch =
        token.exec(text)
    ) !== null
  ) {
    const value =
      cleanRef(
        tokenMatch[1] ??
          "",
      );

    if (
      !value ||
      !hasEnoughReferenceSignal(
        value,
      )
    ) {
      continue;
    }

    let score = 20;

    const compact =
      value.replace(
        /[-_/]/g,
        "",
      );

    if (
      /^[A-Za-z]{2,10}\d{6,}$/i.test(
        compact,
      )
    ) {
      score += 55;
    }

    results.push({
      value,

      index:
        tokenMatch.index,

      source:
        /^[A-Za-z]/.test(
          value,
        )
          ? "bank-prefixed"
          : "token",

      score,
    });
  }

  return results;
}

function uniqueCandidates(
  candidates: Candidate[],
): Candidate[] {
  const seen =
    new Map<
      string,
      Candidate
    >();

  for (
    const candidate of
      candidates
  ) {
    const key =
      candidate.value.toUpperCase();

    const existing =
      seen.get(key);

    if (
      !existing ||
      candidate.score >
        existing.score
    ) {
      seen.set(
        key,
        candidate,
      );
    }
  }

  return [
    ...seen.values(),
  ];
}

/* ------------------------------------------------------------------ *
 * Candidate scoring
 * ------------------------------------------------------------------ */

function scoreCandidate(
  text: string,
  candidate: Candidate,
  mode: DebitMode,
): number {
  let score =
    candidate.score;

  const value =
    candidate.value;

  const before =
    text.slice(
      Math.max(
        0,
        candidate.index -
          50,
      ),
      candidate.index,
    );

  const after =
    text.slice(
      candidate.index +
        value.length,

      candidate.index +
        value.length +
        35,
    );

  const nearby =
    `${before} ${after}`;

  if (
    EXPLICIT_REF_RE.test(
      before,
    )
  ) {
    score += 90;
  }

  if (
    BAD_REF_CONTEXT.test(
      before,
    )
  ) {
    score -= 140;
  }

  /*
   * 12 digit strong preference for
   * UPI and IMPS.
   */
  if (
    /^\d{12}$/.test(
      value,
    )
  ) {
    if (
      mode === "UPI" ||
      mode === "IMPS"
    ) {
      score += 80;
    } else {
      score += 15;
    }
  }

  /*
   * Bank-prefixed reference preference for
   * NEFT / RTGS.
   */
  const compact =
    value.replace(
      /[-_/]/g,
      "",
    );

  if (
    /^[A-Za-z]{2,10}\d{6,}$/i.test(
      compact,
    )
  ) {
    if (
      mode === "NEFT" ||
      mode === "RTGS"
    ) {
      score += 80;
    } else {
      score += 20;
    }
  }

  /*
   * Strong exclusions.
   */
  if (
    looksLikeIfsc(
      value,
    )
  ) {
    score -= 350;
  }

  if (
    looksLikeDate(
      value,
    )
  ) {
    score -= 350;
  }

  if (
    looksLikeMoney(
      value,
    )
  ) {
    score -= 300;
  }

  if (
    looksLikeMobile(
      value,
    )
  ) {
    score -= 200;
  }

  if (
    looksLikeAccountNumber(
      value,
    )
  ) {
    score -= 100;
  }

  if (
    /\b(?:account|acct|a\/c|beneficiary|mobile|phone|ifsc|vpa|customer|cif)\b/i.test(
      nearby,
    )
  ) {
    score -= 65;
  }

  /*
   * Reference proximity to payment mode.
   */
  const modeRe =
    MODE_PATTERNS.find(
      (pattern) =>
        pattern.mode ===
        mode,
    )?.re;

  const modeIndex =
    modeRe
      ? text.search(
          modeRe,
        )
      : -1;

  if (
    modeIndex >= 0
  ) {
    const distance =
      Math.abs(
        candidate.index -
          modeIndex,
      );

    score +=
      Math.max(
        0,
        85 -
          Math.floor(
            distance / 4,
          ),
      );
  }

  const left =
    text.slice(
      Math.max(
        0,
        candidate.index -
          30,
      ),
      candidate.index,
    );

  if (
    mode === "UPI" &&
    /(?:UPI|RRN|TRTR|P2A|P2M)[\s/_:-]*$/i.test(
      left,
    )
  ) {
    score += 65;
  }

  if (
    mode === "IMPS" &&
    /(?:IMPS|PS|P2A|P2P|PSP2A|IMPSP2A)[\s/_:-]*$/i.test(
      left,
    )
  ) {
    score += 65;
  }

  if (
    mode === "NEFT" &&
    /(?:NEFT|IBNEFT|ENEFT|XUTR|OUT)[\s/_:-]*$/i.test(
      left,
    )
  ) {
    score += 70;
  }

  if (
    mode === "RTGS" &&
    /(?:RTGS|IBRTGS|ERTGS)[\s/_:-]*$/i.test(
      left,
    )
  ) {
    score += 70;
  }

  return score;
}

/* ------------------------------------------------------------------ *
 * Dedicated cell reference
 * ------------------------------------------------------------------ */

function extractRefFromDedicatedCells(
  cells: Row,
  cols: ColumnMap | null,
): string | null {
  for (
    let index = 0;
    index < cells.length;
    index++
  ) {
    if (
      index ===
        cols?.date ||
      index ===
        cols?.credit ||
      index ===
        cols?.debit ||
      index ===
        cols?.amount ||
      index ===
        cols?.balance ||
      index ===
        cols?.type
    ) {
      continue;
    }

    const cell =
      cleanRef(
        cells[index] ??
          "",
      );

    if (
      !cell ||
      /\s/.test(cell)
    ) {
      continue;
    }

    if (
      !hasEnoughReferenceSignal(
        cell,
      )
    ) {
      continue;
    }

    if (
      looksLikeIfsc(cell) ||
      looksLikeDate(cell) ||
      looksLikeMoney(cell)
    ) {
      continue;
    }

    if (
      /^\d{12}$/.test(
        cell,
      ) ||
      /^[A-Za-z]{3,10}\d{8,30}$/i.test(
        cell.replace(
          /[-_/]/g,
          "",
        ),
      )
    ) {
      return cell;
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Public UTR extractor
 * ------------------------------------------------------------------ */

export function extractDebitRef(
  text: string,
  mode: DebitMode,
  cells?: Row,
  cols?: ColumnMap | null,
): string | null {
  if (
    cells
  ) {
    const dedicated =
      extractRefFromDedicatedCells(
        cells,
        cols ?? null,
      );

    if (
      dedicated
    ) {
      return dedicated;
    }
  }

  const normalized =
    text
      .replace(
        /\u00a0/g,
        " ",
      )

      .replace(
        /[–—]/g,
        "-",
      )

      .replace(
        /\s*([/:_-])\s*/g,
        "$1",
      )

      .replace(
        /\s+/g,
        " ",
      )

      .trim();

  const candidates =
    uniqueCandidates([
      ...explicitReferenceCandidates(
        normalized,
      ),

      ...modeSpecificCandidates(
        normalized,
        mode,
      ),

      ...genericCandidates(
        normalized,
      ),
    ]);

  if (
    !candidates.length
  ) {
    return null;
  }

  const ranked =
    candidates
      .map(
        (candidate) => ({
          candidate,

          score:
            scoreCandidate(
              normalized,
              candidate,
              mode,
            ),
        }),
      )

      .filter(
        ({
          candidate,
        }) => {
          const value =
            candidate.value;

          if (
            !hasEnoughReferenceSignal(
              value,
            )
          ) {
            return false;
          }

          if (
            looksLikeIfsc(
              value,
            )
          ) {
            return false;
          }

          if (
            looksLikeDate(
              value,
            )
          ) {
            return false;
          }

          if (
            looksLikeMoney(
              value,
            )
          ) {
            return false;
          }

          return true;
        },
      )

      .sort(
        (a, b) =>
          b.score -
            a.score ||
          a.candidate
            .index -
            b.candidate
              .index,
      );

  const best =
    ranked[0];

  if (
    !best ||
    best.score < 25
  ) {
    return null;
  }

  return best
    .candidate.value;
}

/* ------------------------------------------------------------------ *
 * ROW AMOUNT
 * ------------------------------------------------------------------ */

type RowValue = {
  index: number;
  value: number;
};

function rowValues(
  cells: Row,
  cols: ColumnMap | null,
): RowValue[] {
  if (
    cells.length === 1
  ) {
    return moneyTokens(
      cells[0] || "",
    ).map(
      (token, index) => ({
        index,
        value:
          toNumber(token),
      }),
    );
  }

  const results:
    RowValue[] = [];

  cells.forEach(
    (cell, index) => {
      if (
        cols?.date ===
          index ||
        cols?.narration ===
          index
      ) {
        return;
      }

      const value =
        cellAmount(
          cell || "",
        );

      if (
        value !== null
      ) {
        results.push({
          index,
          value,
        });
      }
    },
  );

  return results;
}

/* ------------------------------------------------------------------ *
 * DIRECTION ENGINE
 * ------------------------------------------------------------------ */

/**
 * Direction priority:
 *
 * 1. Debit/Credit columns
 * 2. Transaction DR/CR indicator
 * 3. Negative amount
 * 4. Balance movement
 * 5. Narration fallback
 *
 * Balance "CR" does NOT mean current row is credit.
 */
function classifyDebit(
  cells: Row,
  text: string,
  cols: ColumnMap | null,
  prevBalance: number | null,
): {
  isDebit: boolean;
  amount: number | null;
  balance: number | null;
} {
  const values =
    rowValues(
      cells,
      cols,
    );

  let balance:
    number | null =
    null;

  let balanceIndex:
    number | null =
    null;

  if (
    cols?.balance !== undefined
  ) {
    const value =
      cellAmount(
        cells[
          cols.balance
        ] || "",
      );

    if (
      value !== null
    ) {
      balance =
        Math.abs(
          value,
        );

      balanceIndex =
        cols.balance;
    }
  } else if (
    values.length >= 2
  ) {
    const last =
      values[
        values.length -
          1
      ]!;

    balance =
      Math.abs(
        last.value,
      );

    balanceIndex =
      last.index;
  }

  const nonBalance =
    values.filter(
      (value) =>
        value.index !==
        balanceIndex,
    );

  /* 1. Debit/Credit columns */

  const debitCell =
    cols?.debit !== undefined
      ? cellAmount(
          cells[
            cols.debit
          ] || "",
        )
      : null;

  const creditCell =
    cols?.credit !== undefined
      ? cellAmount(
          cells[
            cols.credit
          ] || "",
        )
      : null;

  if (
    debitCell !== null &&
    debitCell !== 0
  ) {
    return {
      isDebit: true,

      amount:
        Math.abs(
          debitCell,
        ),

      balance,
    };
  }

  if (
    creditCell !== null &&
    creditCell !== 0
  ) {
    return {
      isDebit: false,

      amount:
        Math.abs(
          creditCell,
        ),

      balance,
    };
  }

  /* 2. Explicit DR/CR */

  const typeCell =
    cols?.type !== undefined
      ? cells[
          cols.type
        ] || ""
      : "";

  const indicator =
    typeCell ||
    cells.find(
      (cell) =>
        /^\s*(dr|debit|cr|credit|d|c)\.?\s*$/i.test(
          cell || "",
        ),
    ) ||
    "";

  if (
    indicator
  ) {
    if (
      /^\s*(dr|debit|d)\.?\s*$/i.test(
        indicator,
      )
    ) {
      const candidate =
        nonBalance.find(
          (value) =>
            Math.abs(
              value.value,
            ) > 0,
        );

      return {
        isDebit:
          true,

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
      /^\s*(cr|credit|c)\.?\s*$/i.test(
        indicator,
      )
    ) {
      return {
        isDebit:
          false,

        amount:
          null,

        balance,
      };
    }
  }

  /* 3. Negative amount */

  const negative =
    nonBalance.find(
      (value) =>
        value.value < 0,
    );

  if (
    negative
  ) {
    return {
      isDebit: true,

      amount:
        Math.abs(
          negative.value,
        ),

      balance,
    };
  }

  /* 4. Balance movement */

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

    if (
      delta < 0
    ) {
      const candidate =
        nonBalance.find(
          (value) =>
            Math.abs(
              Math.abs(
                value.value,
              ) -
                Math.abs(
                  delta,
                ),
            ) < 0.02,
        );

      return {
        isDebit:
          true,

        amount:
          candidate
            ? Math.abs(
                candidate.value,
              )
            : Math.abs(
                delta,
              ),

        balance,
      };
    }

    if (
      delta > 0
    ) {
      return {
        isDebit:
          false,

        amount:
          null,

        balance,
      };
    }
  }

  /* 5. Narration */

  const cleaned =
    text.replace(
      BALANCE_WORDS,
      " ",
    );

  const debit =
    DEBIT_WORDS.test(
      cleaned,
    );

  const credit =
    CREDIT_WORDS.test(
      cleaned,
    );

  if (
    debit &&
    !credit
  ) {
    const candidate =
      nonBalance.find(
        (value) =>
          Math.abs(
            value.value,
          ) > 0,
      );

    return {
      isDebit:
        true,

      amount:
        candidate
          ? Math.abs(
              candidate.value,
            )
          : null,

      balance,
    };
  }

  return {
    isDebit:
      false,

    amount:
      null,

    balance,
  };
}

/* ------------------------------------------------------------------ *
 * MAIN DEBIT ENGINE
 * ------------------------------------------------------------------ */

function analyzeDebits(
  inputRows: Row[],
): DebitResult {
  const results:
    DebitTxn[] = [];

  let columns:
    ColumnMap | null =
    null;

  let headerLength = 0;

  let previousBalance:
    number | null =
    null;

  for (
    const raw of inputRows
  ) {
    const cells =
      raw.map(
        (cell) =>
          cell == null
            ? ""
            : String(
                cell,
              )
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
      continue;
    }

    /*
     * Opening balance.
     */
    if (
      /\b(opening\s*balance|balance\s*b\/?f|brought\s*forward|b\/f)\b/i.test(
        text,
      )
    ) {
      const tokens =
        moneyTokens(
          text,
        );

      if (
        tokens.length
      ) {
        previousBalance =
          Math.abs(
            toNumber(
              tokens[
                tokens.length -
                  1
              ] ?? "",
            ),
          );
      }

      continue;
    }

    /*
     * Header.
     */
    const detected =
      detectColumns(
        cells,
      );

    if (
      detected &&
      extractDate(
        text,
      ) === null
    ) {
      columns =
        detected;

      headerLength =
        cells.length;

      continue;
    }

    const rowColumns =
      columns &&
      cells.length ===
        headerLength
        ? columns
        : null;

    const dateCell =
      rowColumns?.date !==
      undefined
        ? cells[
            rowColumns.date
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

    if (
      !date
    ) {
      continue;
    }

    /*
     * Current balance before direction classification.
     */
    const values =
      rowValues(
        cells,
        rowColumns,
      );

    let currentBalance:
      number | null =
      null;

    if (
      rowColumns?.balance !==
      undefined
    ) {
      const value =
        cellAmount(
          cells[
            rowColumns
              .balance
          ] || "",
        );

      if (
        value !== null
      ) {
        currentBalance =
          Math.abs(
            value,
          );
      }
    } else if (
      values.length >= 2
    ) {
      currentBalance =
        Math.abs(
          values[
            values.length -
              1
          ]!.value,
        );
    }

    const oldBalance =
      previousBalance;

    if (
      currentBalance !== null
    ) {
      previousBalance =
        currentBalance;
    }

    if (
      EXCLUDE_RE.test(
        text,
      )
    ) {
      continue;
    }

    const mode =
      detectMode(
        text,
      );

    if (
      !mode
    ) {
      continue;
    }

    const classified =
      classifyDebit(
        cells,
        text,
        rowColumns,
        oldBalance,
      );

    if (
      !classified.isDebit
    ) {
      continue;
    }

    let amount =
      classified.amount;

    /*
     * Explicit generic amount column.
     */
    if (
      (
        amount === null ||
        amount <= 0
      ) &&
      rowColumns?.amount !==
        undefined
    ) {
      const value =
        cellAmount(
          cells[
            rowColumns
              .amount
          ] || "",
        );

      if (
        value !== null
      ) {
        amount =
          Math.abs(
            value,
          );
      }
    }

    /*
     * Last fallback.
     */
    if (
      amount === null ||
      amount <= 0
    ) {
      const fallbackValues =
        values.filter(
          (value) =>
            rowColumns
              ?.balance ===
              undefined ||
            value.index !==
              rowColumns.balance,
        );

      const candidate =
        fallbackValues.find(
          (value) =>
            value.value < 0,
        ) ??
        fallbackValues.find(
          (value) =>
            Math.abs(
              value.value,
            ) > 0,
        );

      if (
        candidate
      ) {
        amount =
          Math.abs(
            candidate.value,
          );
      }
    }

    if (
      !amount ||
      amount <= 0
    ) {
      continue;
    }

    /*
     * Reference extraction is independent.
     *
     * DO NOT DROP debit if UTR is unavailable.
     */
    const reference =
      extractDebitRef(
        text,
        mode,
        cells,
        rowColumns,
      );

    results.push({
      date,

      utr:
        reference ??
        "N/A",

      amount:
        fmtAmount(
          amount,
        ),

      mode,
    });
  }

  return {
    rows:
      dedupeDebits(
        results,
      ),
  };
}

/* ------------------------------------------------------------------ *
 * TEXT SUPPORT
 * ------------------------------------------------------------------ */

/**
 * A transaction can wrap across multiple lines.
 * Continuation lines without a new date are attached to the previous row.
 */
function stitchLines(
  lines: string[],
): string[] {
  const results:
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
      results.length === 0
    ) {
      results.push(
        line,
      );
    } else {
      results[
        results.length -
          1
      ] +=
        " " +
        line.trim();
    }
  }

  return results;
}

function lineToCells(
  line: string,
): Row {
  if (
    line.includes("|")
  ) {
    return line
      .split("|")
      .map(
        (part) =>
          part.trim(),
      );
  }

  if (
    line.includes("\t")
  ) {
    return line
      .split("\t")
      .map(
        (part) =>
          part.trim(),
      );
  }

  const spaces =
    line
      .split(
        /\s{2,}/,
      )
      .map(
        (part) =>
          part.trim(),
      );

  if (
    spaces.length >= 3
  ) {
    return spaces;
  }

  return [
    line.trim(),
  ];
}

/* ------------------------------------------------------------------ *
 * PUBLIC API
 * ------------------------------------------------------------------ */

export function parseDebitsFromText(
  text: string,
): DebitResult {
  const lines =
    stitchLines(
      text.split(
        /\r?\n/,
      ),
    );

  return analyzeDebits(
    lines.map(
      lineToCells,
    ),
  );
}

export function parseDebitsFromRows(
  rows: Row[],
): DebitResult {
  return analyzeDebits(
    rows.map(
      (row) =>
        row.map(
          (cell) =>
            cell == null
              ? ""
              : String(
                  cell,
                ),
        ),
    ),
  );
}

export function mergeDebitResults(
  list: DebitResult[],
): DebitResult {
  return {
    rows:
      dedupeDebits(
        list.flatMap(
          (result) =>
            result.rows,
        ),
      ),
  };
}

function dedupeDebits(
  rows: DebitTxn[],
): DebitTxn[] {
  const seen =
    new Set<string>();

  return rows.filter(
    (row) => {
      const key =
        `${row.date}|${row.utr}|${row.amount}|${row.mode}`;

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

/* ------------------------------------------------------------------ *
 * SUMMARY / BREAKDOWN
 * ------------------------------------------------------------------ */

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
    ];

  return modes.map(
    (mode) => {
      const selected =
        rows.filter(
          (row) =>
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

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

export function toDebitCsv(
  rows: DebitTxn[],
): string {
  return [
    "Date,UTR,Amount,Mode",

    ...rows.map(
      (row) =>
        `${row.date},${row.utr},${row.amount},${row.mode}`,
    ),
  ].join("\n");
}

export function timestampName(
  prefix: string,
): string {
  const date =
    new Date();

  const pad =
    (value: number) =>
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
