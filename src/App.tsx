import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Grid,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Title
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCpu,
  IconLanguage,
  IconMicrophone,
  IconPlayerStop,
  IconRefresh,
  IconSparkles,
  IconWifi,
  IconWifiOff
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PipecatHandlers,
  PipecatSession,
  PipecatStatus,
  checkHealth,
  getPipecatConfig,
  processAudio,
  translateText
} from './api';

const languageOptions = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ta', label: 'Tamil' },
  { value: 'te', label: 'Telugu' },
  { value: 'fr', label: 'French' }
];

type Mode = 'batch' | 'live';

export function App() {
  // ── Shared state ──────────────────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>('live');
  const [sourceLanguage, setSourceLanguage] = useState(import.meta.env.VITE_SOURCE_LANGUAGE || 'en');
  const [targetLanguage, setTargetLanguage] = useState(import.meta.env.VITE_TARGET_LANGUAGE || 'hi');
  const [errorMessage, setErrorMessage] = useState('');
  const [healthState, setHealthState] = useState<{
    ready: boolean;
    deepgramModel: string;
    openrouterModel: string;
    hasDeepgramKey: boolean;
    hasOpenrouterKey: boolean;
  } | null>(null);

  // ── Batch-mode state ──────────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [batchTranscript, setBatchTranscript] = useState('');
  const [batchTranslation, setBatchTranslation] = useState('');
  const [batchStatus, setBatchStatus] = useState('Ready for recording');
  const [batchWarning, setBatchWarning] = useState('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // ── Live-mode state ───────────────────────────────────────────────────────
  const [pipecatStatus, setPipecatStatus] = useState<PipecatStatus>('idle');
  const [livePartial, setLivePartial] = useState('');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [liveTranslation, setLiveTranslation] = useState('');
  const sessionRef = useRef<PipecatSession | null>(null);

  const appTitle = import.meta.env.VITE_APP_TITLE || 'Rizerve Voice Console';
  const deepgramModel = import.meta.env.VITE_DEEPGRAM_MODEL || 'nova-2';

  // ── Derived labels ────────────────────────────────────────────────────────
  const overallStatus = useMemo(() => {
    if (mode === 'live') {
      switch (pipecatStatus) {
        case 'connecting': return 'Connecting';
        case 'ready':      return 'Listening';
        case 'error':      return 'Error';
        case 'closed':     return 'Disconnected';
        default:           return 'Idle';
      }
    }
    if (isRecording)  return 'Recording';
    if (isProcessing) return 'Processing';
    if (isTranslating) return 'Translating';
    return 'Idle';
  }, [mode, pipecatStatus, isRecording, isProcessing, isTranslating]);

  const statusColor = useMemo(() => {
    if (mode === 'live') {
      if (pipecatStatus === 'ready')      return 'teal';
      if (pipecatStatus === 'connecting') return 'orange';
      if (pipecatStatus === 'error')      return 'red';
      return 'gray';
    }
    if (isRecording)  return 'red';
    if (isProcessing || isTranslating) return 'orange';
    return 'teal';
  }, [mode, pipecatStatus, isRecording, isProcessing, isTranslating]);

  // ── Health check ──────────────────────────────────────────────────────────
  const refreshHealth = async () => {
    try {
      const response = await checkHealth();
      setHealthState({
        ready: response.status === 'ok',
        deepgramModel: response.config.deepgramModel,
        openrouterModel: response.config.openrouterModel,
        hasDeepgramKey: response.config.hasDeepgramKey,
        hasOpenrouterKey: response.config.hasOpenrouterKey
      });
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to reach backend API.');
      setHealthState(null);
    }
  };

  useEffect(() => {
    refreshHealth();
    return () => {
      cleanupBatchStream();
      sessionRef.current?.stop();
    };
  }, []);

  // ── Batch helpers ─────────────────────────────────────────────────────────
  const cleanupBatchStream = () => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
  };

  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErrorMessage('Microphone access is not supported in this browser.');
        return;
      }
      setErrorMessage('');
      setBatchWarning('');
      setBatchStatus('Microphone active. Speak now.');
      audioChunksRef.current = [];

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };

      recorder.onstop = async () => {
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        cleanupBatchStream();

        if (blob.size === 0) {
          setBatchWarning('No audio captured. Please try again.');
          setIsRecording(false);
          setBatchStatus('Ready for recording');
          return;
        }

        setIsRecording(false);
        setIsProcessing(true);
        setBatchStatus('Transcribing and translating…');

        try {
          const response = await processAudio({ audio: blob, sourceLanguage, targetLanguage });
          setBatchTranscript(response.transcript || '');
          setBatchTranslation(response.translatedText || '');
          setLatencyMs(response.latencyMs ?? null);
          setBatchWarning(response.warning || '');
          setBatchStatus('Completed. Review transcript and translation.');
          setErrorMessage('');
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : 'Audio processing failed.');
          setBatchStatus('Request failed. Check API configuration.');
        } finally {
          setIsProcessing(false);
        }
      };

      recorder.start();
      setIsRecording(true);
    } catch (error) {
      cleanupBatchStream();
      setIsRecording(false);
      setErrorMessage(error instanceof Error ? error.message : 'Microphone permission denied.');
      setBatchStatus('Unable to start recording');
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
  };

  const onTranslate = async () => {
    if (!batchTranscript.trim()) {
      setBatchWarning('Transcript is empty. Record audio or type text first.');
      return;
    }
    setIsTranslating(true);
    setErrorMessage('');
    setBatchWarning('');
    try {
      const response = await translateText({ text: batchTranscript, sourceLanguage, targetLanguage });
      setBatchTranslation(response.translatedText);
      setBatchStatus('Translation updated from OpenRouter.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Translation failed.');
      setBatchStatus('Translation failed');
    } finally {
      setIsTranslating(false);
    }
  };

  const onReset = () => {
    setBatchTranscript('');
    setBatchTranslation('');
    setIsRecording(false);
    setIsProcessing(false);
    setIsTranslating(false);
    setBatchStatus('Ready for recording');
    setBatchWarning('');
    setErrorMessage('');
    setLatencyMs(null);
    cleanupBatchStream();
  };

  // ── Live helpers ──────────────────────────────────────────────────────────
  const startLive = useCallback(async () => {
    setErrorMessage('');
    setLivePartial('');
    setLiveTranscript('');
    setLiveTranslation('');

    const handlers: PipecatHandlers = {
      onStatusChange: (s) => setPipecatStatus(s),
      onTranscript: (text, isFinal) => {
        if (isFinal) {
          setLiveTranscript((prev) => (prev ? prev + ' ' + text : text));
          setLivePartial('');
        } else {
          setLivePartial(text);
        }
      },
      onTranslation: (_src, translated) => {
        setLiveTranslation((prev) => (prev ? prev + ' ' + translated : translated));
      },
      onError: (msg) => setErrorMessage(msg)
    };

    const session = new PipecatSession(handlers);
    sessionRef.current = session;

    try {
      const cfg = await getPipecatConfig();
      await session.start({
        wsUrl: cfg.wsUrl,
        sourceLanguage,
        targetLanguage
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to start live session.');
      setPipecatStatus('error');
      sessionRef.current = null;
    }
  }, [sourceLanguage, targetLanguage]);

  const stopLive = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }, []);

  const onModeChange = (next: string) => {
    if (next === mode) return;
    // Tear down active sessions when switching
    if (isRecording) stopRecording();
    if (pipecatStatus === 'ready' || pipecatStatus === 'connecting') stopLive();
    setMode(next as Mode);
    setErrorMessage('');
  };

  const liveIsActive = pipecatStatus === 'ready' || pipecatStatus === 'connecting';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Container size="lg" py="xl">
      <Stack gap="lg">
        {/* Header */}
        <Paper p="lg" withBorder>
          <Group justify="space-between" align="flex-start">
            <Stack gap={4}>
              <Title order={1}>{appTitle}</Title>
              <Text c="dimmed">
                {mode === 'live'
                  ? 'Live mode — Pipecat streams mic audio through Deepgram STT → OpenRouter translation in real time.'
                  : 'Batch mode — Record a clip, then transcribe and translate via REST API.'}
              </Text>
            </Stack>
            <Badge color={statusColor} variant="light" size="lg">{overallStatus}</Badge>
          </Group>
        </Paper>

        {/* Mode toggle */}
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={onModeChange}
          data={[
            { label: 'Live (Pipecat)', value: 'live' },
            { label: 'Batch (REST)', value: 'batch' }
          ]}
        />

        {/* Info cards */}
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Card withBorder padding="md">
            <Stack gap={4}>
              <Group gap="xs">
                <ThemeIcon size="sm" color="teal" variant="light"><IconCpu size={14} /></ThemeIcon>
                <Text fw={600}>Deepgram Model</Text>
              </Group>
              <Text>{healthState?.deepgramModel || deepgramModel}</Text>
            </Stack>
          </Card>

          <Card withBorder padding="md">
            <Stack gap={4}>
              <Group gap="xs">
                <ThemeIcon size="sm" color="orange" variant="light"><IconLanguage size={14} /></ThemeIcon>
                <Text fw={600}>OpenRouter Model</Text>
              </Group>
              <Text lineClamp={1}>{healthState?.openrouterModel || 'Not available'}</Text>
            </Stack>
          </Card>

          <Card withBorder padding="md">
            <Stack gap={4}>
              <Group gap="xs">
                <ThemeIcon size="sm" color="blue" variant="light"><IconSparkles size={14} /></ThemeIcon>
                <Text fw={600}>{mode === 'live' ? 'Pipeline' : 'Last Latency'}</Text>
              </Group>
              <Text>
                {mode === 'live'
                  ? pipecatStatus === 'ready' ? 'Streaming' : pipecatStatus
                  : latencyMs ? `${latencyMs} ms` : 'No run yet'}
              </Text>
            </Stack>
          </Card>
        </SimpleGrid>

        {/* Alerts */}
        {errorMessage && (
          <Alert color="red" title="Error" icon={<IconAlertTriangle size={16} />}>
            {errorMessage}
          </Alert>
        )}

        {/* ── LIVE MODE ───────────────────────────────────────────────── */}
        {mode === 'live' && (
          <>
            <Card withBorder radius="md" padding="lg">
              <Stack>
                <Group justify="space-between">
                  <Text fw={600}>Live Controls</Text>
                  <Group gap="xs">
                    <Badge
                      color={healthState?.hasDeepgramKey ? 'teal' : 'gray'}
                      variant="light"
                    >
                      Deepgram Key: {healthState?.hasDeepgramKey ? 'Loaded' : 'Missing'}
                    </Badge>
                    <Badge
                      color={healthState?.hasOpenrouterKey ? 'teal' : 'gray'}
                      variant="light"
                    >
                      OpenRouter Key: {healthState?.hasOpenrouterKey ? 'Loaded' : 'Missing'}
                    </Badge>
                  </Group>
                </Group>

                <Grid>
                  <Grid.Col span={{ base: 12, sm: 6 }}>
                    <Select
                      label="Source language"
                      value={sourceLanguage}
                      onChange={(v) => setSourceLanguage(v || 'en')}
                      data={languageOptions}
                      disabled={liveIsActive}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, sm: 6 }}>
                    <Select
                      label="Target language"
                      value={targetLanguage}
                      onChange={(v) => setTargetLanguage(v || 'hi')}
                      data={languageOptions.filter((o) => o.value !== sourceLanguage)}
                      disabled={liveIsActive}
                    />
                  </Grid.Col>
                </Grid>

                <Group>
                  {!liveIsActive ? (
                    <Button
                      leftSection={<IconWifi size={16} />}
                      onClick={startLive}
                      color="teal"
                    >
                      Start Live Session
                    </Button>
                  ) : (
                    <Button
                      leftSection={<IconWifiOff size={16} />}
                      onClick={stopLive}
                      color="red"
                    >
                      Stop Live Session
                    </Button>
                  )}
                  <Button
                    variant="default"
                    onClick={refreshHealth}
                    disabled={liveIsActive}
                  >
                    Check API Health
                  </Button>
                </Group>

                {pipecatStatus === 'connecting' && <Progress value={60} animated />}
                {pipecatStatus === 'ready' && (
                  <Alert color="teal" title="Pipeline active" icon={<IconCircleCheck size={16} />}>
                    Mic is live — speak in {sourceLanguage.toUpperCase()}. Translation appears after each sentence pause.
                  </Alert>
                )}
              </Stack>
            </Card>

            {/* Live transcript */}
            <Card withBorder radius="md" padding="lg">
              <Stack>
                <Text fw={600}>Live Transcript ({sourceLanguage.toUpperCase()})</Text>
                <Paper withBorder radius="md" p="sm" mih={110} bg="dark.9">
                  <Text style={{ whiteSpace: 'pre-wrap' }}>
                    {liveTranscript}
                    {livePartial && (
                      <Text span c="dimmed"> {livePartial}</Text>
                    )}
                    {!liveTranscript && !livePartial && (
                      <Text c="dimmed">Transcript will stream here as you speak…</Text>
                    )}
                  </Text>
                </Paper>
              </Stack>
            </Card>

            {/* Live translation */}
            <Card withBorder radius="md" padding="lg">
              <Stack>
                <Text fw={600}>Live Translation ({targetLanguage.toUpperCase()})</Text>
                <Paper withBorder radius="md" p="sm" mih={110}>
                  <Text style={{ whiteSpace: 'pre-wrap' }}>
                    {liveTranslation || (
                      <Text c="dimmed" span>
                        Translation appears here after each sentence pause…
                      </Text>
                    )}
                  </Text>
                </Paper>
              </Stack>
            </Card>
          </>
        )}

        {/* ── BATCH MODE ──────────────────────────────────────────────── */}
        {mode === 'batch' && (
          <>
            {batchWarning && (
              <Alert color="yellow" title="Notice" icon={<IconAlertTriangle size={16} />}>
                {batchWarning}
              </Alert>
            )}

            <Alert color="teal" title="Current Status" icon={<IconCircleCheck size={16} />}>
              {batchStatus}
            </Alert>

            <Card withBorder radius="md" padding="lg">
              <Stack>
                <Group justify="space-between">
                  <Text fw={600}>Recording Controls</Text>
                  <Text size="sm" c="dimmed">
                    Deepgram: {deepgramModel} | Source: {sourceLanguage}
                  </Text>
                </Group>

                <Grid>
                  <Grid.Col span={{ base: 12, sm: 6 }}>
                    <Select
                      label="Source language"
                      value={sourceLanguage}
                      onChange={(v) => setSourceLanguage(v || 'en')}
                      data={languageOptions}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, sm: 6 }}>
                    <Select
                      label="Target language"
                      value={targetLanguage}
                      onChange={(v) => setTargetLanguage(v || 'hi')}
                      data={languageOptions.filter((o) => o.value !== sourceLanguage)}
                    />
                  </Grid.Col>
                </Grid>

                <Group>
                  {isRecording ? (
                    <Button leftSection={<IconPlayerStop size={16} />} onClick={stopRecording} color="red">
                      Stop Recording
                    </Button>
                  ) : (
                    <Button
                      leftSection={<IconMicrophone size={16} />}
                      onClick={startRecording}
                      color="teal"
                      disabled={isProcessing || isTranslating}
                    >
                      Start Recording
                    </Button>
                  )}
                  <Button onClick={refreshHealth} variant="default" disabled={isProcessing || isTranslating || isRecording}>
                    Check API Health
                  </Button>
                  <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={onReset}>
                    Reset
                  </Button>
                </Group>

                {(isProcessing || isTranslating) && <Progress value={75} animated />}

                <Group gap="xs">
                  <Badge color={healthState?.hasDeepgramKey ? 'teal' : 'gray'} variant="light">
                    Deepgram Key: {healthState?.hasDeepgramKey ? 'Loaded' : 'Missing'}
                  </Badge>
                  <Badge color={healthState?.hasOpenrouterKey ? 'teal' : 'gray'} variant="light">
                    OpenRouter Key: {healthState?.hasOpenrouterKey ? 'Loaded' : 'Missing'}
                  </Badge>
                </Group>
              </Stack>
            </Card>

            <Card withBorder radius="md" padding="lg">
              <Stack>
                <Text fw={600}>Transcript ({sourceLanguage.toUpperCase()})</Text>
                <Textarea
                  value={batchTranscript}
                  onChange={(e) => setBatchTranscript(e.currentTarget.value)}
                  minRows={5}
                  autosize
                  placeholder="Live transcript will appear here…"
                />
              </Stack>
            </Card>

            <Card withBorder radius="md" padding="lg">
              <Stack>
                <Group grow>
                  <Button
                    mt={25}
                    onClick={onTranslate}
                    color="orange"
                    leftSection={<IconSparkles size={16} />}
                    loading={isTranslating}
                    disabled={isProcessing || isRecording}
                  >
                    Translate Transcript
                  </Button>
                </Group>

                <Divider />

                <Stack gap="xs">
                  <Text fw={600}>Translated output ({targetLanguage.toUpperCase()})</Text>
                  <Paper withBorder radius="md" p="sm" mih={110}>
                    <Text>{batchTranslation || 'Translation will appear here once generated.'}</Text>
                  </Paper>
                </Stack>
              </Stack>
            </Card>
          </>
        )}
      </Stack>
    </Container>
  );
}
