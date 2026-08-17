/* ------------------------------------------------------------------ *
 * OCR SERVER
 *
 * Used ONLY when:
 * - PDF has no useful text layer
 * - PDF page is scanned/image based
 * - User directly uploads an image
 *
 * IMPORTANT:
 * Native bank-downloaded text PDFs do NOT require AI OCR.
 *
 * Provider priority:
 * 1. Generic OCR_API_URL + OCR_API_KEY
 * 2. Existing Lovable API configuration
 *
 * This removes hard dependency on Lovable.
 * ------------------------------------------------------------------ */

const LOVABLE_GATEWAY =
  "https://ai.gateway.lovable.dev/v1/chat/completions";

/* ------------------------------------------------------------------ *
 * OCR prompt
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `
You are a strict Indian bank statement transaction transcription engine.

Your job is NOT to explain the statement.

Your job is to convert visible transaction rows into structured plain text.

OUTPUT FORMAT

Output exactly ONE transaction per line.

Every line must have exactly SIX fields separated by:

 |

Format:

transaction date | narration / description | reference | debit amount | credit amount | balance

Example:

31-03-2026 | UPI/517291060497/CR/MD SHA/IPO | 517291060497 | | 500.00 | 535.38

Example debit:

20-12-2025 | IMPS/P2A/607813136431/ABC | 607813136431 | 5000.00 | | 8000.00

STRICT RULES

1. Preserve transaction order exactly as shown in the statement.

2. Every actual transaction must remain on ONE output line.

3. If narration wraps across multiple printed lines, combine it into the same transaction line.

4. Copy transaction date exactly.

5. Copy narration exactly enough to preserve:
   - UPI
   - IMPS
   - P2A
   - P2P
   - NEFT
   - RTGS
   - IBNEFT
   - IBRTGS
   - eNEFT
   - eRTGS
   - RRN
   - UTR
   - XUTR
   - reference
   - CR
   - DR

6. Never invent a UTR or reference.

7. Never modify digits.

8. Never remove leading zeros.

9. Never round amounts.

10. Never convert debit into credit or credit into debit.

11. If the statement has separate Debit and Credit columns:
    - put Debit value only in debit amount
    - put Credit value only in credit amount

12. If the statement has a single Amount column plus CR/DR:
    - DR => debit amount
    - CR => credit amount

13. If transaction amount is visibly negative:
    place the absolute numeric amount in debit amount.

14. A running balance ending in CR or DR is NOT automatically the transaction direction.

15. Reference field priority when visible:
    UTR
    RRN
    Ref No
    Reference
    Transaction ID

16. For UPI:
    preserve 12-digit RRN/UPI reference exactly.

17. For IMPS:
    preserve references such as:
    IMPS/P2A/607813136431
    PS/P2A/618713187090
    PSP2A619557502254
    IMPSP2A619520526511

18. For NEFT and RTGS:
    preserve complete alphanumeric UTR/reference.

Examples:

NEFT-BARBL26078306964

PUNBN62025121456687398

AXNH261850049792

BARBR52026031900028575

MAHBR52026061124182338

19. If a transaction genuinely has no visible reference:
    leave the reference field empty.

20. Never use account number, mobile number, IFSC, VPA or balance as a fake reference.

21. Skip:
    - bank logo
    - account holder details
    - address
    - account number header
    - CIF/customer ID
    - IFSC header
    - statement summary
    - opening page titles
    - page numbers
    - footer
    - totals that are not transaction rows

22. Do NOT output markdown.

23. Do NOT output code fences.

24. Do NOT output headings.

25. Output transaction lines only.
`.trim();

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

type ProviderConfig = {
  url: string;
  apiKey: string;
  model: string;
  headers: Record<string, string>;
};

function getProvider(): ProviderConfig {
  /*
   * Preferred generic provider.
   *
   * Any OpenAI-compatible vision endpoint can be configured:
   *
   * OCR_API_URL
   * OCR_API_KEY
   * OCR_MODEL
   */
  const genericUrl =
    process.env["OCR_API_URL"];

  const genericKey =
    process.env["OCR_API_KEY"];

  const genericModel =
    process.env["OCR_MODEL"];

  if (
    genericUrl &&
    genericKey
  ) {
    return {
      url: genericUrl,

      apiKey:
        genericKey,

      model:
        genericModel ||
        "vision-model",

      headers: {
        "Content-Type":
          "application/json",

        Authorization:
          `Bearer ${genericKey}`,
      },
    };
  }

  /*
   * Backward compatibility:
   * use Lovable only when its key exists.
   */
  const lovableKey =
    process.env[
      "LOVABLE_API_KEY"
    ];

  if (
    lovableKey
  ) {
    return {
      url:
        LOVABLE_GATEWAY,

      apiKey:
        lovableKey,

      model:
        process.env[
          "LOVABLE_OCR_MODEL"
        ] ||
        "google/gemini-3.6-flash",

      headers: {
        "Content-Type":
          "application/json",

        "Lovable-API-Key":
          lovableKey,
      },
    };
  }

  throw new Error(
    "OCR provider is not configured. Native text PDFs, XLS, XLSX, CSV and TXT can still be processed, but scanned PDFs/images require OCR_API_URL + OCR_API_KEY + OCR_MODEL.",
  );
}

/* ------------------------------------------------------------------ *
 * Response extraction
 * ------------------------------------------------------------------ */

function extractResponseText(
  json: unknown,
): string {
  if (
    !json ||
    typeof json !==
      "object"
  ) {
    return "";
  }

  const data =
    json as {
      choices?: Array<{
        message?: {
          content?:
            | string
            | Array<{
                type?: string;
                text?: string;
              }>;
        };
      }>;
    };

  const content =
    data.choices?.[0]
      ?.message?.content;

  if (
    typeof content ===
    "string"
  ) {
    return content;
  }

  if (
    Array.isArray(
      content,
    )
  ) {
    return content
      .map(
        (item) =>
          item.text ??
          "",
      )
      .join("\n");
  }

  return "";
}

/* ------------------------------------------------------------------ *
 * Clean OCR output
 * ------------------------------------------------------------------ */

function cleanOcrText(
  text: string,
): string {
  return text
    .replace(
      /^```(?:text)?/i,
      "",
    )

    .replace(
      /```$/,
      "",
    )

    .split(
      /\r?\n/,
    )

    .map(
      (line) =>
        line.trim(),
    )

    .filter(
      (line) =>
        Boolean(line),
    )

    /*
     * Keep only structured OCR rows.
     */
    .filter(
      (line) => {
        const separators =
          (
            line.match(
              /\|/g,
            ) ?? []
          ).length;

        return (
          separators >= 5
        );
      },
    )

    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Single page
 * ------------------------------------------------------------------ */

async function transcribePage(
  image: string,
  pageNumber: number,
  provider: ProviderConfig,
): Promise<string> {
  let response:
    Response;

  try {
    response =
      await fetch(
        provider.url,
        {
          method:
            "POST",

          headers:
            provider.headers,

          body:
            JSON.stringify(
              {
                model:
                  provider.model,

                temperature:
                  0,

                messages: [
                  {
                    role:
                      "system",

                    content:
                      SYSTEM_PROMPT,
                  },

                  {
                    role:
                      "user",

                    content: [
                      {
                        type:
                          "text",

                        text:
                          `Transcribe every transaction row visible on bank statement page ${pageNumber}. Output only the six-field pipe-separated transaction rows.`,
                      },

                      {
                        type:
                          "image_url",

                        image_url:
                          {
                            url:
                              image,
                          },
                      },
                    ],
                  },
                ],
              },
            ),
        },
      );
  } catch (
    error
  ) {
    throw new Error(
      error instanceof Error
        ? `OCR network error: ${error.message}`
        : "OCR network request failed.",
    );
  }

  /* -------------------------------------------------------------- *
   * Provider errors
   * -------------------------------------------------------------- */

  if (
    response.status ===
    401 ||
    response.status ===
    403
  ) {
    throw new Error(
      "OCR authentication failed. Check OCR API credentials.",
    );
  }

  if (
    response.status ===
    402
  ) {
    throw new Error(
      "OCR provider credits are exhausted.",
    );
  }

  if (
    response.status ===
    429
  ) {
    throw new Error(
      "OCR rate limit reached. Please retry shortly.",
    );
  }

  if (
    response.status >=
    500
  ) {
    throw new Error(
      `OCR provider temporarily unavailable (${response.status}).`,
    );
  }

  if (
    !response.ok
  ) {
    let detail = "";

    try {
      detail =
        await response.text();
    } catch {
      detail = "";
    }

    throw new Error(
      `OCR request failed (${response.status})${
        detail
          ? `: ${detail.slice(
              0,
              200,
            )}`
          : ""
      }`,
    );
  }

  let json:
    unknown;

  try {
    json =
      await response.json();
  } catch {
    throw new Error(
      "OCR provider returned an invalid response.",
    );
  }

  const text =
    cleanOcrText(
      extractResponseText(
        json,
      ),
    );

  return text;
}

/* ------------------------------------------------------------------ *
 * Public function
 * ------------------------------------------------------------------ */

/**
 * Transcribes statement page images into normalized transaction rows.
 *
 * Each returned line:
 *
 * Date |
 * Narration |
 * Reference |
 * Debit |
 * Credit |
 * Balance
 */
export async function transcribePages(
  images: string[],
): Promise<string> {
  if (
    !Array.isArray(
      images,
    ) ||
    images.length === 0
  ) {
    return "";
  }

  const provider =
    getProvider();

  const chunks:
    string[] = [];

  /*
   * Process sequentially.
   *
   * This intentionally avoids sending 12 large bank pages
   * simultaneously and reduces rate-limit / memory problems.
   */
  for (
    let index = 0;
    index <
    images.length;
    index++
  ) {
    const image =
      images[index];

    if (
      !image
    ) {
      continue;
    }

    const text =
      await transcribePage(
        image,
        index + 1,
        provider,
      );

    if (
      text.trim()
    ) {
      chunks.push(
        text.trim(),
      );
    }
  }

  return chunks.join(
    "\n",
  );
}
