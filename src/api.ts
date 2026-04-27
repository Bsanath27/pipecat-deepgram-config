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

type PipecatConfigResponse = {
  wsUrl: string;
  sampleRate: number;
  channels: number;
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

export async function getPipecatConfig(): Promise<PipecatConfigResponse> {
  const response = await fetch('/api/pipecat-config');
  return parseResponse<PipecatConfigResponse>(response);
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

// ---------------------------------------------------------------------------
// Pipecat live session — streams raw 16-bit PCM mono via WebSocket
// ---------------------------------------------------------------------------

export type PipecatStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'closed';

export type PipecatHandlers = {
  onTranscript: (text: string, isFinal: boolean) => void;
  onTranslation: (sourceText: string, translatedText: string) => void;
  onStatusChange: (status: PipecatStatus) => void;
  onError: (message: string) => void;
};

// AudioWorklet processor source — runs inside the browser's audio thread.
// Downsamples from the browser's native rate to TARGET_RATE and converts
// Float32 samples to signed 16-bit PCM.
const WORKLET_SOURCE = `
const TARGET_RATE = 16000;

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / TARGET_RATE;
    this._buf = [];
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;

    for (let i = 0; i < ch.length; i++) {
      this._buf.push(ch[i]);
    }

    const outLen = Math.floor(this._buf.length / this._ratio);
    if (outLen === 0) return true;

    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = this._buf[Math.round(i * this._ratio)] ?? 0;
      out[i] = Math.max(-32768, Math.min(32767, (s * 32768) | 0));
    }

    this._buf = this._buf.slice(Math.round(outLen * this._ratio));
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
`;

export class PipecatSession {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private handlers: PipecatHandlers;

  constructor(handlers: PipecatHandlers) {
    this.handlers = handlers;
  }

  async start(options: {
    wsUrl: string;
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<void> {
    this.handlers.onStatusChange('connecting');

    // -- WebSocket --
    const ws = new WebSocket(options.wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket connection failed'));
      ws.onclose = () => reject(new Error('WebSocket closed before ready'));
    });

    // Send config and wait for "ready" ack
    ws.send(
      JSON.stringify({
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage
      })
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Pipecat ready timeout')), 8000);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            resolve();
          }
        } catch {
          // ignore non-JSON during handshake
        }
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket error during handshake'));
      };
    });

    // Attach live message handler
    ws.onmessage = (ev) => this._handleMessage(ev.data as string);
    ws.onclose = () => this.handlers.onStatusChange('closed');
    ws.onerror = () => this.handlers.onError('WebSocket error');

    // -- Microphone + AudioWorklet --
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    this.audioCtx = new AudioContext();

    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await this.audioCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    this.worklet = new AudioWorkletNode(this.audioCtx, 'pcm-processor');
    this.worklet.port.onmessage = (ev) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(ev.data as ArrayBuffer);
      }
    };

    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.source.connect(this.worklet);
    this.worklet.connect(this.audioCtx.destination);

    this.handlers.onStatusChange('ready');
  }

  stop(): void {
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close();
    this.ws?.close();

    this.ws = null;
    this.audioCtx = null;
    this.worklet = null;
    this.source = null;
    this.stream = null;

    this.handlers.onStatusChange('closed');
  }

  private _handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'transcript':
          this.handlers.onTranscript(msg.text ?? '', msg.is_final ?? false);
          break;
        case 'translation':
          this.handlers.onTranslation(msg.source_text ?? '', msg.translated_text ?? '');
          break;
        case 'error':
          this.handlers.onError(msg.message ?? 'Unknown pipeline error');
          break;
      }
    } catch {
      // ignore malformed frames
    }
  }
}
