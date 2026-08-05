import { createServerFn } from "@tanstack/react-start";

export const ocrStatementPages = createServerFn({ method: "POST" })
  .inputValidator((input: { images: string[] }) => {
    if (!input || !Array.isArray(input.images) || input.images.length === 0) {
      throw new Error("No pages to read.");
    }
    if (input.images.length > 12) throw new Error("Too many pages to read at once (max 12).");
    return { images: input.images };
  })
  .handler(async ({ data }) => {
    const { transcribePages } = await import("./ocr.server");
    return { text: await transcribePages(data.images) };
  });
