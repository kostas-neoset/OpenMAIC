import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type { ImageMapping, PdfImage, SceneOutline, UserRequirements } from '@/lib/types/generation';

type OutlineRequestPayload = {
  requirements: UserRequirements;
  pdfText?: string;
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  researchContext?: string;
  agents?: AgentInfo[];
  visionImageLimit?: number;
};

type SceneContentRequestPayload = {
  outline: SceneOutline;
  allOutlines: SceneOutline[];
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  stageInfo: {
    name: string;
    description?: string;
    language?: string;
    style?: string;
  };
  stageId: string;
  agents?: AgentInfo[];
};

function pickImageMappingSubset(
  pdfImages: PdfImage[] | undefined,
  imageMapping: ImageMapping | undefined,
  limit: number,
): ImageMapping | undefined {
  if (!pdfImages?.length || !imageMapping) return imageMapping;

  const subset: ImageMapping = {};
  let count = 0;

  for (const image of pdfImages) {
    const src = imageMapping[image.id];
    if (!src) continue;

    subset[image.id] = src;
    count += 1;
    if (count >= limit) break;
  }

  return Object.keys(subset).length > 0 ? subset : undefined;
}

function filterImagesForOutline(
  outline: SceneOutline,
  pdfImages: PdfImage[] | undefined,
  imageMapping: ImageMapping | undefined,
): { pdfImages?: PdfImage[]; imageMapping?: ImageMapping } {
  const suggestedIds = outline.suggestedImageIds;
  if (!pdfImages?.length || !suggestedIds?.length) {
    return { pdfImages, imageMapping };
  }

  const wanted = new Set(suggestedIds);
  const filteredImages = pdfImages.filter((image) => wanted.has(image.id));

  if (!imageMapping) {
    return { pdfImages: filteredImages };
  }

  const filteredMapping: ImageMapping = {};
  for (const image of filteredImages) {
    const src = imageMapping[image.id];
    if (src) filteredMapping[image.id] = src;
  }

  return {
    pdfImages: filteredImages,
    imageMapping: Object.keys(filteredMapping).length > 0 ? filteredMapping : undefined,
  };
}

export function buildOutlineRequestPayload({
  requirements,
  pdfText,
  pdfImages,
  imageMapping,
  researchContext,
  agents,
  visionImageLimit = MAX_VISION_IMAGES,
}: OutlineRequestPayload) {
  return {
    requirements,
    pdfText,
    pdfImages,
    imageMapping: pickImageMappingSubset(pdfImages, imageMapping, visionImageLimit),
    researchContext,
    agents,
  };
}

export function buildSceneContentRequestPayload({
  outline,
  allOutlines,
  pdfImages,
  imageMapping,
  stageInfo,
  stageId,
  agents,
}: SceneContentRequestPayload) {
  const filtered = filterImagesForOutline(outline, pdfImages, imageMapping);

  return {
    outline,
    allOutlines,
    pdfImages: filtered.pdfImages,
    imageMapping: filtered.imageMapping,
    stageInfo,
    stageId,
    agents,
  };
}

export async function readApiErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const raw = (await response.text().catch(() => '')).trim();

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { error?: string; details?: string };
      if (parsed.details) return parsed.details;
      if (parsed.error) return parsed.error;
    } catch {
      // Non-JSON responses are expected from some hosting limits.
    }
  }

  if (
    response.status === 413 ||
    raw.includes('Request Entity Too Large') ||
    raw.includes('FUNCTION_PAYLOAD_TOO_LARGE')
  ) {
    return 'This PDF contains too much PDF image data for the hosted site. Try a smaller PDF, fewer images, or a self-hosted deployment.';
  }

  return raw || response.statusText || fallbackMessage;
}
