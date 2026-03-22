# MinerU Official API Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add support for MinerU's official hosted API so a Vercel-hosted OpenMAIC can accept direct PDF uploads and parse them with MinerU cloud services.

**Architecture:** Keep the existing `mineru` provider id, but branch its implementation into two modes. Hosted mode uses MinerU's batch upload and batch result APIs, downloads `full_zip_url`, and adapts the zip contents into the current `ParsedPdfContent` shape. Self-hosted `/file_parse` mode remains as a backward-compatible path.

**Tech Stack:** Next.js route handlers, TypeScript, `fetch`, `jszip`, existing PDF provider settings UI, Vercel environment variables.

---

### Task 1: Add Hosted MinerU Helper Logic

**Files:**
- Create: `lib/pdf/mineru-hosted.ts`
- Modify: `lib/pdf/types.ts`

**Step 1: Write the failing verification harness**

Create a small fixture-driven verification script or helper scaffold that captures the hosted MinerU responsibilities:

- choose hosted vs self-hosted mode from config
- request upload URLs
- poll batch results
- parse MinerU zip contents into markdown, images, and content metadata

If no dedicated test runner is available, use a local verification harness under `scripts/` or a temporary node command during implementation instead of inventing a new framework dependency.

**Step 2: Run the verification harness to confirm the helper does not exist yet**

Run an import or build check that fails because the helper module and exports do not exist yet.

Expected: missing-module or missing-export failure.

**Step 3: Write minimal hosted helper implementation**

Add focused functions such as:

```ts
export function isHostedMinerUConfig(config: PDFParserConfig): boolean
export async function uploadFileToMinerU(...)
export async function pollMinerUBatchResult(...)
export async function parseMinerUZipResult(...)
```

The zip parser should read:

- `full.md`
- `*_content_list.json`
- `images/*`

and return a structure that can be converted into `ParsedPdfContent`.

**Step 4: Run the harness/build check again**

Run the same import or build check and confirm the helper now resolves.

**Step 5: Commit**

```bash
git add lib/pdf/mineru-hosted.ts lib/pdf/types.ts
git commit -m "feat: add hosted MinerU helper flow"
```

### Task 2: Wire Hosted MinerU Into The Parser

**Files:**
- Modify: `lib/pdf/pdf-providers.ts`

**Step 1: Write the failing behavior check**

Capture the current failure case:

- hosted MinerU config with official API key cannot process a directly uploaded PDF because the code only posts to `/file_parse`

Use a focused local call path or manual repro note that proves the current code assumes self-hosted MinerU.

**Step 2: Run the failing behavior check**

Run:

```bash
pnpm build
```

and confirm the current implementation still only targets `${baseUrl}/file_parse` in the parser logic.

**Step 3: Write minimal parser changes**

Update `parseWithMinerU` so it:

- uses hosted MinerU when a hosted config is detected
- keeps the current self-hosted `/file_parse` path for compatibility
- downloads `full_zip_url`
- converts the zip result into the existing `ParsedPdfContent` shape
- preserves current metadata fields used by downstream lesson generation

**Step 4: Run verification**

Run:

```bash
pnpm build
```

Expected: build passes.

**Step 5: Commit**

```bash
git add lib/pdf/pdf-providers.ts
git commit -m "feat: support MinerU official API parsing"
```

### Task 3: Update PDF Provider Verification And Settings UI

**Files:**
- Modify: `app/api/verify-pdf-provider/route.ts`
- Modify: `components/settings/pdf-settings.tsx`
- Modify: `lib/i18n/settings.ts`

**Step 1: Write the failing UX check**

Document the current mismatch:

- UI preview always shows `/file_parse`
- connection testing assumes a self-hosted base URL
- labels imply local/server-only MinerU usage

**Step 2: Run the failing UX check**

Start the app and inspect the MinerU settings UI.

Run:

```bash
pnpm dev
```

Expected: MinerU settings still show the self-hosted `/file_parse` assumption.

**Step 3: Write minimal UI and verification changes**

Update the settings flow so:

- hosted MinerU is described clearly
- hosted mode can work with just an API key
- self-hosted mode remains understandable
- the request URL preview does not lie about `/file_parse` in hosted mode
- the verification route either performs a safe hosted-mode config check or clearly reports that live upload is the authoritative test

**Step 4: Run verification**

Run:

```bash
pnpm build
```

Expected: build passes with updated UI text and route logic.

**Step 5: Commit**

```bash
git add app/api/verify-pdf-provider/route.ts components/settings/pdf-settings.tsx lib/i18n/settings.ts
git commit -m "feat: clarify hosted MinerU settings"
```

### Task 4: Update Docs And Deployment Config Guidance

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `lib/pdf/README.md`

**Step 1: Write the failing docs check**

List the docs that still describe MinerU only as:

- self-hosted `/file_parse`
- local server URL examples only
- `.env.local` guidance that does not explain hosted mode defaults

**Step 2: Run the failing docs check**

Review the current docs and confirm the mismatch.

**Step 3: Write minimal docs updates**

Document:

- hosted MinerU as the recommended Vercel-compatible path
- self-hosted MinerU as an advanced alternative
- `PDF_MINERU_API_KEY`
- optional `PDF_MINERU_BASE_URL`
- expected live verification flow after Vercel redeploy

**Step 4: Run verification**

Run:

```bash
pnpm build
```

Expected: build still passes after docs and env updates.

**Step 5: Commit**

```bash
git add .env.example README.md lib/pdf/README.md
git commit -m "docs: add hosted MinerU deployment guidance"
```

### Task 5: Verify Locally And Prepare Vercel Rollout

**Files:**
- No required source changes

**Step 1: Write the failing live check**

Use a real PDF and confirm that hosted MinerU parsing is not yet verified on the local deployment.

**Step 2: Run the failing live check**

Run the app locally and try a real PDF upload with hosted MinerU config.

Expected before final polish: at least one rough edge, timeout, or metadata mismatch may still appear.

**Step 3: Fix the smallest remaining issue**

Only patch the specific blocker found during the live verification run.

**Step 4: Run final verification**

Run:

```bash
pnpm build
pnpm exec next dev --port 3004
```

Then verify:

- homepage loads
- PDF upload works with hosted MinerU
- parsing returns usable markdown and images

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: finish hosted MinerU support"
```

### Task 6: Push To The User's Fork And Redeploy

**Files:**
- No source changes required

**Step 1: Confirm push target**

This clone currently points at the upstream repo, not the user's fork. Before pushing, repoint `origin` to the user's fork or add a dedicated fork remote after user confirmation.

**Step 2: Push the implementation**

Run:

```bash
git push
```

If a fork remote is used instead:

```bash
git push <fork-remote> main
```

**Step 3: Update Vercel environment variables**

Set:

- `PDF_MINERU_API_KEY`
- optionally `PDF_MINERU_BASE_URL` if a custom hosted base is needed

**Step 4: Redeploy and verify**

After Vercel redeploys, test a real PDF upload on the live site.

**Step 5: Commit deployment notes if needed**

If any repo docs or deployment notes changed during rollout:

```bash
git add -A
git commit -m "docs: finalize MinerU rollout notes"
git push
```
