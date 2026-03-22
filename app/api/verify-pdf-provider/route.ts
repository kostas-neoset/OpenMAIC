import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolvePDFApiKey, resolvePDFBaseUrl } from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  getMinerUHostedVerificationUrl,
  isMinerUHostedConfig,
} from '@/lib/pdf/mineru-hosted';

const log = createLogger('Verify PDF Provider');

export async function POST(req: NextRequest) {
  try {
    const { providerId, apiKey, baseUrl } = await req.json();

    if (!providerId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Provider ID is required');
    }

    const clientBaseUrl = (baseUrl as string | undefined) || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const resolvedBaseUrl = clientBaseUrl ? clientBaseUrl : resolvePDFBaseUrl(providerId, baseUrl);
    const resolvedApiKey = clientBaseUrl
      ? (apiKey as string | undefined) || ''
      : resolvePDFApiKey(providerId, apiKey);
    const isHostedMinerU =
      providerId === 'mineru' &&
      isMinerUHostedConfig({ providerId: 'mineru', baseUrl: resolvedBaseUrl });

    if (isHostedMinerU) {
      if (!resolvedApiKey) {
        return apiError(
          'MISSING_API_KEY',
          400,
          'MinerU API key is required for the official hosted API',
        );
      }

      return apiSuccess({
        message: 'Hosted MinerU is configured. Upload a PDF to verify end-to-end parsing.',
        status: 200,
        mode: 'hosted',
        requestUrl: getMinerUHostedVerificationUrl(resolvedBaseUrl),
      });
    }

    const requestUrl = resolvedBaseUrl;

    if (!requestUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Base URL is required');
    }

    const headers: Record<string, string> = {};
    if (resolvedApiKey) {
      headers['Authorization'] = `Bearer ${resolvedApiKey}`;
    }

    const response = await fetch(requestUrl, {
      headers,
      signal: AbortSignal.timeout(10000),
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }

    // For self-hosted MinerU, the FastAPI root may return 404.
    // For hosted MinerU, the batch endpoint may return 401/403/405 on a probe request.
    // Any direct HTTP response means the service is reachable.
    return apiSuccess({
      message: 'Connection successful',
      status: response.status,
      mode: providerId === 'mineru' ? 'self-hosted' : 'remote',
      requestUrl,
    });
  } catch (error) {
    log.error('PDF provider test error:', error);

    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      if (error.message.includes('ECONNREFUSED')) {
        errorMessage = 'Cannot connect to server, please check the Base URL';
      } else if (error.message.includes('ENOTFOUND')) {
        errorMessage = 'Server not found, please check the Base URL';
      } else if (error.message.includes('timeout') || error.name === 'TimeoutError') {
        errorMessage = 'Connection timed out';
      } else {
        errorMessage = error.message;
      }
    }

    return apiError('INTERNAL_ERROR', 500, errorMessage);
  }
}
