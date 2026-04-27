import cors from 'cors';
import express from 'express';
import multer from 'multer';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const config = {
  apiPort: Number(process.env.API_PORT || '8787'),
  appPort: Number(process.env.APP_PORT || '3000'),
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  deepgramModel: process.env.DEEPGRAM_MODEL || 'nova-2',
  deepgramLanguage: process.env.DEEPGRAM_LANGUAGE || 'en',
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  openrouterModel: process.env.OPENROUTER_MODEL || 'qwen/qwen3-next-80b-a3b-instruct:free',
  openrouterFallbackModels: (process.env.OPENROUTER_FALLBACK_MODELS || 'openrouter/auto')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean),
  openrouterTemperature: Number(process.env.OPENROUTER_TEMPERATURE || '0.2'),
  openrouterSiteUrl: process.env.OPENROUTER_SITE_URL || `http://localhost:${process.env.APP_PORT || 3000}`,
  openrouterAppName: process.env.OPENROUTER_APP_NAME || 'Rizerve Voice Console'
};

app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

function assertConfig(name, value) {
  if (!value) {
    const err = new Error(`${name} is missing from environment variables.`);
    err.statusCode = 500;
    throw err;
  }
}

function extractMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item.text === 'string') {
          return item.text;
        }

        return '';
      })
      .join('')
      .trim();
  }

  return '';
}

async function transcribeWithDeepgram(audioBuffer, mimeType = 'audio/webm') {
  assertConfig('DEEPGRAM_API_KEY', config.deepgramApiKey);

  const url = new URL('https://api.deepgram.com/v1/listen');
  url.searchParams.set('model', config.deepgramModel);
  url.searchParams.set('language', config.deepgramLanguage);
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('filler_words', 'false');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.deepgramApiKey}`,
      'Content-Type': mimeType
    },
    body: audioBuffer
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Deepgram request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';

  return {
    transcript,
    deepgram: data
  };
}

async function requestOpenRouterTranslation(text, sourceLanguage, targetLanguage, model) {
  const response = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.openrouterSiteUrl,
      'X-Title': config.openrouterAppName
    },
    body: JSON.stringify({
      model,
      temperature: config.openrouterTemperature,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict translation engine. Return only the translated text without markdown, notes, or extra explanation.'
        },
        {
          role: 'user',
          content: `Translate from ${sourceLanguage} to ${targetLanguage}:\n\n${text}`
        }
      ]
    })
  });

  return response;
}

async function translateWithOpenRouter(text, sourceLanguage, targetLanguage) {
  assertConfig('OPENROUTER_API_KEY', config.openrouterApiKey);

  const attemptedModels = [config.openrouterModel, ...config.openrouterFallbackModels];
  let lastError = null;

  for (const model of attemptedModels) {
    const response = await requestOpenRouterTranslation(text, sourceLanguage, targetLanguage, model);

    if (!response.ok) {
      const textResponse = await response.text();
      const shouldTryFallback = response.status === 429 || response.status === 503;

      lastError = `OpenRouter request failed for model '${model}' (${response.status}): ${textResponse}`;

      if (shouldTryFallback) {
        continue;
      }

      throw new Error(lastError);
    }

    const data = await response.json();
    const translatedText = extractMessageContent(data?.choices?.[0]?.message?.content);

    return {
      translatedText,
      provider: 'openrouter',
      model: data?.model || model,
      usage: data?.usage || null
    };
  }

  throw new Error(lastError || 'OpenRouter request failed for all configured models.');
}

app.get('/api/pipecat-config', (_req, res) => {
  const port = Number(process.env.PIPECAT_PORT || '8788');
  const host = process.env.PIPECAT_HOST === '0.0.0.0' ? 'localhost' : (process.env.PIPECAT_HOST || 'localhost');
  res.json({
    wsUrl: `ws://${host}:${port}`,
    sampleRate: Number(process.env.PIPECAT_SAMPLE_RATE || '16000'),
    channels: Number(process.env.PIPECAT_CHANNELS || '1')
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    config: {
      deepgramModel: config.deepgramModel,
      deepgramLanguage: config.deepgramLanguage,
      openrouterModel: config.openrouterModel,
      hasDeepgramKey: Boolean(config.deepgramApiKey),
      hasOpenrouterKey: Boolean(config.openrouterApiKey)
    }
  });
});

app.post('/api/translate', async (req, res, next) => {
  try {
    const { text, sourceLanguage = 'en', targetLanguage = 'hi' } = req.body || {};

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required.' });
    }

    const translationResult = await translateWithOpenRouter(text, sourceLanguage, targetLanguage);
    return res.json({
      sourceText: text,
      sourceLanguage,
      targetLanguage,
      translatedText: translationResult.translatedText,
      provider: translationResult.provider,
      model: translationResult.model,
      usage: translationResult.usage
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/transcribe', upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'audio file is required (multipart field: audio).' });
    }

    const result = await transcribeWithDeepgram(req.file.buffer, req.file.mimetype || 'audio/webm');

    return res.json({
      transcript: result.transcript,
      deepgramModel: config.deepgramModel,
      language: config.deepgramLanguage
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/process-audio', upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'audio file is required (multipart field: audio).' });
    }

    const sourceLanguage = (req.body?.sourceLanguage || config.deepgramLanguage || 'en').toString();
    const targetLanguage = (req.body?.targetLanguage || 'hi').toString();
    const startMs = Date.now();

    const transcription = await transcribeWithDeepgram(req.file.buffer, req.file.mimetype || 'audio/webm');

    if (!transcription.transcript) {
      return res.json({
        transcript: '',
        translatedText: '',
        sourceLanguage,
        targetLanguage,
        latencyMs: Date.now() - startMs,
        warning: 'No speech recognized in the provided audio.'
      });
    }

    const translation = await translateWithOpenRouter(transcription.transcript, sourceLanguage, targetLanguage);

    return res.json({
      transcript: transcription.transcript,
      translatedText: translation.translatedText,
      sourceLanguage,
      targetLanguage,
      provider: translation.provider,
      model: translation.model,
      usage: translation.usage,
      latencyMs: Date.now() - startMs
    });
  } catch (error) {
    return next(error);
  }
});

app.use((error, _req, res, _next) => {
  const statusCode = Number(error.statusCode || 500);
  const message = error?.message || 'Unexpected server error.';
  res.status(statusCode).json({ error: message });
});

app.listen(config.apiPort, () => {
  console.log(`API server running on http://localhost:${config.apiPort}`);
  console.log(`Expected web client on http://localhost:${config.appPort}`);
});
