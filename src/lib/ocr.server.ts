const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

const SYSTEM_PROMPT = `You transcribe Indian bank statement pages into plain text.
Rules:
- Output ONE LINE per transaction row, preserving the original reading order.
- Keep every value of the row on that single line, separated by " | " in this order when present:
  transaction date | narration/description | reference | debit amount | credit amount | balance
- If the statement uses a single amount column with a Cr/Dr indicator, keep the indicator text.
- Copy digits exactly (references, UTRs, amounts). Never invent or reformat numbers.
- Skip headers, footers, logos, account summaries and balance summaries.
- Output nothing except the transaction lines.`;

/** Transcribe statement page images (data URLs) into row-per-line text. */
export async function transcribePages(images: string[]): Promise<string> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("AI is not configured for this project.");

  const chunks: string[] = [];

  for (const image of images) {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify({
        model: "google/gemini-3.6-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe the transaction rows of this bank statement page." },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      }),
    });

    if (res.status === 429) throw new Error("AI rate limit reached. Please retry in a moment.");
    if (res.status === 402) throw new Error("AI credits exhausted. Please top up to continue OCR.");
    if (!res.ok) throw new Error(`OCR failed (${res.status}). Please try again.`);

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    if (text.trim()) chunks.push(text.trim());
  }

  return chunks.join("\n");
}
