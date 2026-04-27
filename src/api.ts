type TranslatePayload = {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
};

type TranslateResponse = {
  sourceText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
  model: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
};

type ProcessAudioPayload = {
  audio: Blob;
  sourceLanguage: string;
  targetLanguage: string;
};

type ProcessAudioResponse = {
  transcript: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  latencyMs?: number;
  warning?: string;
  provider?: string;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
};

type HealthResponse = {
  status: string;
  config: {
    deepgramModel: string;
    deepgramLanguage: string;
    openrouterModel: string;
    hasDeepgramKey: boolean;
    hasOpenrouterKey: boolean;
  };
};

async function parseResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof data === 'string' ? data : data?.error || 'Request failed';
    throw new Error(message);
  }

  return data as T;
}

export async function checkHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health');
  return parseResponse<HealthResponse>(response);
}

export async function translateText(payload: TranslatePayload): Promise<TranslateResponse> {
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  return parseResponse<TranslateResponse>(response);
}

export async function processAudio(payload: ProcessAudioPayload): Promise<ProcessAudioResponse> {
  const formData = new FormData();
  formData.append('audio', payload.audio, 'recording.webm');
  formData.append('sourceLanguage', payload.sourceLanguage);
  formData.append('targetLanguage', payload.targetLanguage);

  const response = await fetch('/api/process-audio', {
    method: 'POST',
    body: formData
  });

  return parseResponse<ProcessAudioResponse>(response);
}
