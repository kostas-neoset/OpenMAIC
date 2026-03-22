'use client';

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { CheckCircle2, Eye, EyeOff, Loader2, Zap, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const MINERU_OFFICIAL_SITE_ROOT = 'https://mineru.net';
const MINERU_OFFICIAL_API_ROOT = 'https://mineru.net/api/v4';

/**
 * Get display label for feature
 */
function getFeatureLabel(feature: string, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    text: t('settings.featureText'),
    images: t('settings.featureImages'),
    tables: t('settings.featureTables'),
    formulas: t('settings.featureFormulas'),
    'layout-analysis': t('settings.featureLayoutAnalysis'),
    metadata: t('settings.featureMetadata'),
  };
  return labels[feature] || feature;
}

function normalizeMinerUPreviewBaseUrl(baseUrl?: string): string {
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
    // Ignore parse failures and fall back to trimmed text.
  }

  return trimmed.replace(/\/+$/, '');
}

function isHostedMinerUConfig(baseUrl?: string): boolean {
  if (!baseUrl?.trim()) return true;
  const normalized = normalizeMinerUPreviewBaseUrl(baseUrl);
  return (
    normalized === MINERU_OFFICIAL_API_ROOT ||
    normalized.startsWith(`${MINERU_OFFICIAL_API_ROOT}/`)
  );
}

function getMinerURequestPreview(baseUrl?: string): string {
  const normalized = normalizeMinerUPreviewBaseUrl(baseUrl);
  return isHostedMinerUConfig(baseUrl) ? `${normalized}/file-urls/batch` : `${normalized}/file_parse`;
}

interface PDFSettingsProps {
  selectedProviderId: PDFProviderId;
}

export function PDFSettings({ selectedProviderId }: PDFSettingsProps) {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const pdfProvidersConfig = useSettingsStore((state) => state.pdfProvidersConfig);
  const setPDFProviderConfig = useSettingsStore((state) => state.setPDFProviderConfig);

  const pdfProvider = PDF_PROVIDERS[selectedProviderId];
  const isServerConfigured = !!pdfProvidersConfig[selectedProviderId]?.isServerConfigured;
  const providerConfig = pdfProvidersConfig[selectedProviderId];
  const isMinerU = selectedProviderId === 'mineru';
  const isHostedMinerU = isMinerU && isHostedMinerUConfig(providerConfig?.baseUrl);
  const canTestConnection = isMinerU
    ? Boolean(providerConfig?.apiKey || providerConfig?.baseUrl || isServerConfigured)
    : Boolean(providerConfig?.baseUrl);
  const isApiKeyOptional = !isMinerU || isServerConfigured || !isHostedMinerU;
  const needsRemoteConfig = selectedProviderId === 'mineru';

  // Reset state when provider changes
  const [prevSelectedProviderId, setPrevSelectedProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevSelectedProviderId) {
    setPrevSelectedProviderId(selectedProviderId);
    setShowApiKey(false);
    setTestStatus('idle');
    setTestMessage('');
  }

  const handleTestConnection = async () => {
    if (!canTestConnection) return;

    setTestStatus('testing');
    setTestMessage('');

    try {
      const response = await fetch('/api/verify-pdf-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedProviderId,
          apiKey: providerConfig?.apiKey || '',
          baseUrl: providerConfig?.baseUrl || undefined,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setTestStatus('success');
        setTestMessage(data.message || t('settings.connectionSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(`${t('settings.connectionFailed')}: ${data.error}`);
      }
    } catch (err) {
      setTestStatus('error');
      const message = err instanceof Error ? err.message : String(err);
      setTestMessage(`${t('settings.connectionFailed')}: ${message}`);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* Base URL + API Key Configuration (for remote providers like MinerU) */}
      {(needsRemoteConfig || isServerConfigured) && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">
                {isMinerU ? t('settings.baseUrlOptional') : t('settings.pdfBaseUrl')}
              </Label>
              <div className="flex gap-2">
                <Input
                  name={`pdf-base-url-${selectedProviderId}`}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={isMinerU ? 'https://mineru.net/api/v4' : 'http://localhost:8080'}
                  value={providerConfig?.baseUrl || ''}
                  onChange={(e) =>
                    setPDFProviderConfig(selectedProviderId, { baseUrl: e.target.value })
                  }
                  className="text-sm"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestConnection}
                  disabled={testStatus === 'testing' || !canTestConnection}
                  className="gap-1.5 shrink-0"
                >
                  {testStatus === 'testing' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>
                      <Zap className="h-3.5 w-3.5" />
                      {t('settings.testConnection')}
                    </>
                  )}
                </Button>
              </div>
              {isMinerU && (
                <p className="text-xs text-muted-foreground">{t('settings.mineruHostedBaseUrlHint')}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-sm">
                {t('settings.pdfApiKey')}
                {isApiKeyOptional && (
                  <span className="text-muted-foreground ml-1 font-normal">
                    ({t('settings.optional')})
                  </span>
                )}
              </Label>
              <div className="relative">
                <Input
                  name={`pdf-api-key-${selectedProviderId}`}
                  type={showApiKey ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={
                    isServerConfigured
                      ? t('settings.optionalOverride')
                      : isMinerU
                        ? t('settings.enterMinerUApiKey')
                        : t('settings.enterApiKey')
                  }
                  value={providerConfig?.apiKey || ''}
                  onChange={(e) =>
                    setPDFProviderConfig(selectedProviderId, {
                      apiKey: e.target.value,
                    })
                  }
                  className="font-mono text-sm pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          {isMinerU && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
              <p>{t('settings.mineruHostedDescription')}</p>
              <p className="mt-2">{t('settings.mineruSelfHostedDescription')}</p>
            </div>
          )}

          {/* Test result message */}
          {testMessage && (
            <div
              className={cn(
                'rounded-lg p-3 text-sm',
                testStatus === 'success' &&
                  'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800',
                testStatus === 'error' &&
                  'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800',
              )}
            >
              <div className="flex items-center gap-2">
                {testStatus === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                {testStatus === 'error' && <XCircle className="h-4 w-4 shrink-0" />}
                <span className="break-all">{testMessage}</span>
              </div>
            </div>
          )}

          {/* Request URL Preview */}
          {(() => {
            if (!isMinerU) return null;
            const fullUrl = getMinerURequestPreview(providerConfig?.baseUrl);
            return (
              <p className="text-xs text-muted-foreground break-all">
                {t('settings.requestUrl')}: {fullUrl}
              </p>
            );
          })()}
        </>
      )}

      {/* Features List */}
      <div className="space-y-2">
        <Label className="text-sm">{t('settings.pdfFeatures')}</Label>
        <div className="flex flex-wrap gap-2">
          {pdfProvider.features.map((feature) => (
            <Badge key={feature} variant="secondary" className="font-normal">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              {getFeatureLabel(feature, t)}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
