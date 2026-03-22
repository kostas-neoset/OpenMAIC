import JSZip from 'jszip';
import type { ParsedPdfContent } from '../types/pdf';
import type { PDFParserConfig } from './types';

export const MINERU_OFFICIAL_API_ROOT = 'https://mineru.net/api/v4';
const MINERU_OFFICIAL_SITE_ROOT = 'https://mineru.net';
export const MINERU_DEFAULT_MODEL_VERSION = 'vlm';
export const MINERU_POLL_INTERVAL_MS = 2_000;
export const MINERU_POLL_TIMEOUT_MS = 3 * 60_000;

interface MinerUApiResponse<T> {
  code?: number;
  msg?: string;
  data?: T;
  trace_id?: string;
}

interface MinerUUploadBatchData {
  batch_id?: string;
  file_urls?: string[];
}

interface MinerUExtractProgress {
  extracted_pages?: number;
  total_pages?: number;
  start_time?: string;
}

interface MinerUExtractResult {
  file_name?: string;
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
  data_id?: string;
  extract_progress?: MinerUExtractProgress;
}

interface MinerUBatchResultData {
  batch_id?: string;
  extract_result?: MinerUExtractResult | MinerUExtractResult[];
}

interface MinerUUploadBatchOptions {
  apiKey: string;
  fileName: string;
  baseUrl?: string;
  dataId?: string;
  modelVersion?: string;
}

interface MinerUUploadBatchResponse {
  batchId: string;
  uploadUrl: string;
}

interface PollMinerUBatchOptions {
  apiKey: string;
  batchId: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface MinerUArchivePayload {
  markdown: string;
  contentList: MinerUContentItem[];
  imagesByPath: Record<string, string>;
}

type MinerUContentItem = {
  type?: string;
  img_path?: string;
  image_caption?: string[];
  bbox?: number[];
  page_idx?: number;
};

export function normalizeMinerUApiRoot(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return MINERU_OFFICIAL_API_ROOT;

  try {
    const parsed = new URL(trimmed);
    const normalizedOrigin = parsed.origin.replace(/\/+$/, '');
    const normalizedPath = parsed.pathname.replace(/\/+$/, '');

    if (
      normalizedOrigin === MINERU_OFFICIAL_SITE_ROOT &&
      (normalizedPath === '' || normalizedPath === '/')
    ) {
      return MINERU_OFFICIAL_API_ROOT;
    }
  } catch {
    // Fall back to string normalization for non-URL inputs.
  }

  return trimmed.replace(/\/+$/, '');
}

export function isMinerUHostedConfig(
  config: Pick<PDFParserConfig, 'providerId' | 'baseUrl'>,
): boolean {
  if (config.providerId !== 'mineru') return false;
  const baseUrl = config.baseUrl?.trim();
  if (!baseUrl) return true;

  const normalized = normalizeMinerUApiRoot(baseUrl);
  return (
    normalized === MINERU_OFFICIAL_API_ROOT ||
    normalized.startsWith(`${MINERU_OFFICIAL_API_ROOT}/`)
  );
}

export async function createMinerUUploadBatch(
  options: MinerUUploadBatchOptions,
): Promise<MinerUUploadBatchResponse> {
  if (!options.apiKey) {
    throw new Error('MinerU API key is required for hosted MinerU uploads.');
  }

  const response = await fetch(`${normalizeMinerUApiRoot(options.baseUrl)}/file-urls/batch`, {
    method: 'POST',
    headers: buildMinerUHeaders(options.apiKey),
    body: JSON.stringify({
      files: [
        {
          name: options.fileName,
          data_id: options.dataId,
        },
      ],
      model_version: options.modelVersion ?? MINERU_DEFAULT_MODEL_VERSION,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const json = (await response.json().catch(() => ({}))) as MinerUApiResponse<MinerUUploadBatchData>;
  if (!response.ok || json.code !== 0) {
    throw new Error(
      `MinerU upload batch request failed (${response.status}): ${json.msg || response.statusText}`,
    );
  }

  const batchId = json.data?.batch_id;
  const uploadUrl = json.data?.file_urls?.[0];
  if (!batchId || !uploadUrl) {
    throw new Error('MinerU upload batch response did not include batch_id and upload URL.');
  }

  return { batchId, uploadUrl };
}

export async function uploadFileToMinerU(
  uploadUrl: string,
  fileBuffer: Buffer,
  contentType?: string,
): Promise<void> {
  const body =
    fileBuffer instanceof Buffer ? new Uint8Array(fileBuffer) : new Uint8Array(fileBuffer);
  const headers = contentType ? { 'Content-Type': contentType } : undefined;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers,
    body,
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`MinerU file upload failed (${response.status}): ${response.statusText}`);
  }
}

export async function pollMinerUBatchResult(
  options: PollMinerUBatchOptions,
): Promise<MinerUExtractResult> {
  const timeoutAt = Date.now() + (options.timeoutMs ?? MINERU_POLL_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? MINERU_POLL_INTERVAL_MS;
  const apiRoot = normalizeMinerUApiRoot(options.baseUrl);

  while (Date.now() <= timeoutAt) {
    const response = await fetch(`${apiRoot}/extract-results/batch/${options.batchId}`, {
      headers: buildMinerUHeaders(options.apiKey),
      signal: AbortSignal.timeout(30_000),
    });

    const json =
      ((await response.json().catch(() => ({}))) as MinerUApiResponse<MinerUBatchResultData>) || {};
    if (!response.ok || json.code !== 0) {
      throw new Error(
        `MinerU batch status request failed (${response.status}): ${json.msg || response.statusText}`,
      );
    }

    const extractResult = getFirstExtractResult(json.data);
    const state = extractResult?.state;

    if (!extractResult || !state) {
      throw new Error('MinerU batch status response did not include an extraction result.');
    }

    if (state === 'done') {
      return extractResult;
    }

    if (state === 'failed') {
      throw new Error(`MinerU parsing failed: ${extractResult.err_msg || 'Unknown MinerU error'}`);
    }

    await delay(pollIntervalMs);
  }

  throw new Error('Timed out while waiting for MinerU hosted parsing to finish.');
}

export async function downloadMinerUArchive(fullZipUrl: string): Promise<Buffer> {
  const response = await fetch(fullZipUrl, {
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download MinerU result archive (${response.status}): ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function parseMinerUArchive(archive: Buffer): Promise<ParsedPdfContent> {
  const payload = await extractMinerUArchivePayload(archive);
  return buildParsedPdfContentFromMinerUPayload(payload);
}

export async function extractMinerUArchivePayload(archive: Buffer): Promise<MinerUArchivePayload> {
  const zip = await JSZip.loadAsync(archive);

  const markdownEntry = zip.file('full.md') || findFirstFile(zip, (name) => name.endsWith('/full.md'));
  if (!markdownEntry) {
    throw new Error('MinerU archive is missing full.md.');
  }

  const contentListEntry =
    findFirstFile(zip, (name) => /(^|\/)([^/]+_)?content_list\.json$/i.test(name)) ||
    findFirstFile(zip, (name) => name.endsWith('_content_list.json'));
  if (!contentListEntry) {
    throw new Error('MinerU archive is missing content_list JSON.');
  }

  const markdown = await markdownEntry.async('string');
  const contentListRaw = await contentListEntry.async('string');
  const contentList = JSON.parse(contentListRaw) as MinerUContentItem[];
  if (!Array.isArray(contentList)) {
    throw new Error('MinerU archive content_list JSON is not an array.');
  }

  const imagesByPath: Record<string, string> = {};
  const imageEntries = Object.values(zip.files).filter((entry) => {
    if (entry.dir) return false;
    const normalizedName = normalizeImagePath(entry.name);
    return normalizedName.startsWith('images/') || normalizedName.includes('/images/');
  });

  for (const entry of imageEntries) {
    const base64 = await entry.async('base64');
    imagesByPath[entry.name] = `data:${guessMimeType(entry.name)};base64,${base64}`;
  }

  return {
    markdown,
    contentList,
    imagesByPath,
  };
}

export function buildParsedPdfContentFromMinerUPayload(
  payload: MinerUArchivePayload,
): ParsedPdfContent {
  const imagePathCandidates = collectImagePaths(payload.contentList, payload.imagesByPath);
  const imagePathToId = new Map<string, string>();
  const imageMapping: Record<string, string> = {};
  const pdfImages: NonNullable<ParsedPdfContent['metadata']>['pdfImages'] = [];

  imagePathCandidates.forEach((imgPath, index) => {
    const imageId = `img_${index + 1}`;
    const base64Url =
      payload.imagesByPath[imgPath] || payload.imagesByPath[normalizeImagePath(imgPath)] || '';
    if (!base64Url) return;

    imagePathToId.set(imgPath, imageId);
    imagePathToId.set(normalizeImagePath(imgPath), imageId);
    imagePathToId.set(getBasename(imgPath), imageId);
    imageMapping[imageId] = base64Url;

    const meta = findImageMeta(payload.contentList, imgPath);
    pdfImages.push({
      id: imageId,
      src: base64Url,
      pageNumber: meta ? meta.pageIdx + 1 : 1,
      description: meta?.caption,
      width: meta ? meta.bbox[2] - meta.bbox[0] : undefined,
      height: meta ? meta.bbox[3] - meta.bbox[1] : undefined,
    });
  });

  const rewrittenMarkdown = rewriteMinerUMarkdownImagePaths(payload.markdown, imagePathToId);
  const pageCount = new Set(
    payload.contentList.map((item) => item.page_idx).filter((page): page is number => page != null),
  ).size;

  return {
    text: rewrittenMarkdown,
    images: Object.values(imageMapping),
    metadata: {
      pageCount,
      parser: 'mineru',
      imageMapping,
      pdfImages,
    },
  };
}

function buildMinerUHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function getFirstExtractResult(data: MinerUBatchResultData | undefined): MinerUExtractResult | undefined {
  const extractResult = data?.extract_result;
  if (Array.isArray(extractResult)) {
    return extractResult[0];
  }
  return extractResult;
}

function findFirstFile(zip: JSZip, predicate: (name: string) => boolean) {
  return Object.values(zip.files).find((entry) => !entry.dir && predicate(entry.name));
}

function collectImagePaths(
  contentList: MinerUContentItem[],
  imagesByPath: Record<string, string>,
): string[] {
  const ordered = new Set<string>();

  for (const item of contentList) {
    if (item.type === 'image' && item.img_path) {
      ordered.add(normalizeImagePath(item.img_path));
    }
  }

  for (const pathKey of Object.keys(imagesByPath).sort()) {
    ordered.add(normalizeImagePath(pathKey));
  }

  return Array.from(ordered);
}

function normalizeImagePath(imgPath: string): string {
  return imgPath.replace(/^\.\/+/, '').replace(/\\/g, '/');
}

function getBasename(imgPath: string): string {
  const normalized = normalizeImagePath(imgPath);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function rewriteMinerUMarkdownImagePaths(markdown: string, imagePathToId: Map<string, string>): string {
  let rewritten = markdown;

  for (const [imgPath, imageId] of imagePathToId.entries()) {
    const escaped = escapeForRegExp(imgPath);
    rewritten = rewritten.replace(new RegExp(`\\((?:\\./)?${escaped}\\)`, 'g'), `(${imageId})`);
  }

  return rewritten;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findImageMeta(contentList: MinerUContentItem[], imgPath: string) {
  const normalized = normalizeImagePath(imgPath);
  const basename = getBasename(imgPath);

  for (const item of contentList) {
    if (item.type !== 'image' || !item.img_path) continue;

    const current = normalizeImagePath(item.img_path);
    if (current !== normalized && getBasename(current) !== basename) continue;

    return {
      pageIdx: item.page_idx ?? 0,
      bbox: item.bbox || [0, 0, 1000, 1000],
      caption: Array.isArray(item.image_caption) ? item.image_caption[0] : undefined,
    };
  }

  return undefined;
}

function guessMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
