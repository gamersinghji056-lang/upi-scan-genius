import { createServerFn } from "@tanstack/react-start";

type OcrInput = {
  images: string[];
};

function validateImages(
  input: OcrInput,
): OcrInput {
  if (
    !input ||
    !Array.isArray(
      input.images,
    )
  ) {
    throw new Error(
      "Invalid OCR request.",
    );
  }

  if (
    input.images.length ===
    0
  ) {
    throw new Error(
      "No pages to read.",
    );
  }

  if (
    input.images.length >
    12
  ) {
    throw new Error(
      "Too many pages to read at once (maximum 12).",
    );
  }

  const images =
    input.images
      .map(
        (image) =>
          typeof image ===
          "string"
            ? image.trim()
            : "",
      )
      .filter(
        Boolean,
      );

  if (
    images.length === 0
  ) {
    throw new Error(
      "No valid page images were provided.",
    );
  }

  for (
    const image of images
  ) {
    /*
     * Browser uploads should normally arrive as data URLs.
     * Keep validation loose enough for existing OCR providers.
     */
    if (
      image.length <
      100
    ) {
      throw new Error(
        "One or more OCR pages are invalid.",
      );
    }
  }

  return {
    images,
  };
}

export const ocrStatementPages =
  createServerFn({
    method: "POST",
  })
    .inputValidator(
      (
        input: OcrInput,
      ) =>
        validateImages(
          input,
        ),
    )
    .handler(
      async ({
        data,
      }) => {
        try {
          const {
            transcribePages,
          } =
            await import(
              "./ocr.server"
            );

          const text =
            await transcribePages(
              data.images,
            );

          return {
            text:
              typeof text ===
              "string"
                ? text
                : "",
          };
        } catch (
          error
        ) {
          const message =
            error instanceof Error
              ? error.message
              : "";

          if (
            /api|key|auth|credential/i.test(
              message,
            )
          ) {
            throw new Error(
              "OCR service is not configured correctly.",
            );
          }

          throw new Error(
            message ||
              "OCR could not read these statement pages.",
          );
        }
      },
    );
