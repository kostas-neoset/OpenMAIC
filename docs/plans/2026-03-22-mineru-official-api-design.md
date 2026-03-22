# MinerU Official API Design

## Goal

Let a Vercel-hosted OpenMAIC deployment support direct PDF uploads from end users while using MinerU's official hosted API for advanced parsing.

## Why This Change Is Needed

OpenMAIC already supports:

- `unpdf` for built-in local parsing
- `mineru` via a self-hosted `/file_parse` endpoint

The current `mineru` implementation assumes a synchronous self-hosted server that accepts a direct multipart upload at `POST {baseUrl}/file_parse` and returns parsed markdown, images, and content metadata in one response.

That does not match MinerU's current hosted API. The official docs show:

- `POST https://mineru.net/api/v4/extract/task` for URL-based extraction tasks
- `POST https://mineru.net/api/v4/file-urls/batch` to obtain upload URLs for direct file uploads
- `GET https://mineru.net/api/v4/extract-results/batch/{batch_id}` to poll batch results
- result archives exposed through `full_zip_url`

The hosted API also notes that the single-task extract interface does not support direct file upload, which matters because the OpenMAIC user flow is "upload a PDF inside the app."

## Chosen Approach

Keep `providerId = 'mineru'`, but add a hosted MinerU mode alongside the existing self-hosted compatibility mode.

Hosted MinerU mode will be the default when:

- a MinerU API key is present, and
- no custom self-hosted `baseUrl` is provided

Self-hosted compatibility mode will continue to work when:

- a custom `baseUrl` is set for an existing `/file_parse` style deployment

This keeps the user-facing provider list stable while making Vercel deployment practical.

## User Experience

For family members using the deployed site:

1. Open OpenMAIC in the browser
2. Upload a PDF normally
3. OpenMAIC sends the file to MinerU's hosted API
4. OpenMAIC waits for MinerU to finish parsing
5. OpenMAIC converts the MinerU result into the format the current lesson-generation pipeline already understands
6. Lesson generation continues normally

No extra websites, no manual upload URLs, and no second server for the family to think about.

## Hosted MinerU Flow

1. OpenMAIC receives the uploaded PDF in `/api/parse-pdf`.
2. For hosted MinerU mode, OpenMAIC requests upload URLs from MinerU batch upload API.
3. OpenMAIC uploads the PDF bytes to the returned upload URL.
4. OpenMAIC polls MinerU batch result status until the file reaches `done`, fails, or times out.
5. OpenMAIC downloads `full_zip_url`.
6. OpenMAIC extracts:
   - `full.md`
   - the matching `*_content_list.json`
   - files under `images/`
7. OpenMAIC converts those files into the existing `ParsedPdfContent` shape:
   - markdown becomes `text`
   - extracted images become `images`
   - image and content metadata become `metadata.imageMapping` and `metadata.pdfImages`

## Compatibility Rules

- Keep the current self-hosted MinerU `/file_parse` flow working for existing users.
- Do not change the `unpdf` provider.
- Do not require a new provider entry in the UI if `mineru` can support both modes safely.

## Configuration Model

For hosted MinerU on Vercel:

- `PDF_MINERU_API_KEY` should be required
- `PDF_MINERU_BASE_URL` should be optional
- if omitted, hosted mode should use a built-in default API root

For self-hosted MinerU:

- `PDF_MINERU_BASE_URL` should continue to point at the self-hosted service
- `PDF_MINERU_API_KEY` remains optional unless that service requires auth

## Verification Plan

1. Local verification with a real PDF upload against hosted MinerU mode
2. `pnpm build`
3. Vercel environment variable update
4. Production redeploy
5. Live PDF upload verification on the deployed site

## Risks

- MinerU hosted API is async, so parsing will take longer than the current self-hosted synchronous flow.
- MinerU hosted API is a paid or quota-limited cloud dependency.
- The app must handle polling failures and timeout errors clearly.
- Result archive parsing must be resilient to minor filename differences inside the zip.

## Git Note

This local clone currently points at the upstream `THU-MAIC/OpenMAIC` repository rather than the user's fork. Before pushing the final implementation for Vercel to deploy, the push target must be updated to the user's fork or an additional fork remote must be added.
