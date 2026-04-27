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
  IconSparkles
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { checkHealth, processAudio, translateText } from './api';

const languageOptions = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ta', label: 'Tamil' },
  { value: 'te', label: 'Telugu' },
  { value: 'fr', label: 'French' }
];

export function App() {
    const [isRecording, setIsRecording] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isTranslating, setIsTranslating] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
    const [sourceLanguage, setSourceLanguage] = useState(import.meta.env.VITE_SOURCE_LANGUAGE || 'en');
  const [targetLanguage, setTargetLanguage] = useState(import.meta.env.VITE_TARGET_LANGUAGE || 'hi');
    const [statusMessage, setStatusMessage] = useState('Ready for recording');
    const [errorMessage, setErrorMessage] = useState('');
    const [warningMessage, setWarningMessage] = useState('');
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const [healthState, setHealthState] = useState<{
      ready: boolean;
      deepgramModel: string;
      openrouterModel: string;
      hasDeepgramKey: boolean;
      hasOpenrouterKey: boolean;
    } | null>(null);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);

  const appTitle = import.meta.env.VITE_APP_TITLE || 'Rizerve Voice Console';
  const deepgramModel = import.meta.env.VITE_DEEPGRAM_MODEL || 'nova-2';

  const pipelineStatus = useMemo(() => {
      if (isRecording) {
        return 'Recording';
      }

      if (isProcessing) {
        return 'Processing';
      }

      if (isTranslating) {
        return 'Translating';
      }

      return 'Idle';
    }, [isProcessing, isRecording, isTranslating]);

    const statusColor = useMemo(() => {
      if (isRecording) {
        return 'red';
      }

      if (isProcessing || isTranslating) {
        return 'orange';
      }

      return 'teal';
    }, [isProcessing, isRecording, isTranslating]);

    const cleanupStream = () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
    };

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
        const message = error instanceof Error ? error.message : 'Unable to reach backend API.';
        setErrorMessage(message);
        setHealthState(null);
      }
    };

    useEffect(() => {
      refreshHealth();

      return () => {
        cleanupStream();
      };
    }, []);

    const startRecording = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setErrorMessage('Microphone access is not supported in this browser.');
          return;
        }

        setErrorMessage('');
        setWarningMessage('');
        setStatusMessage('Microphone active. Speak now.');
        audioChunksRef.current = [];

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;

        const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        recorder.onstop = async () => {
          const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          cleanupStream();

          if (blob.size === 0) {
            setWarningMessage('No audio captured. Please try again.');
            setIsRecording(false);
            setStatusMessage('Ready for recording');
            return;
          }

          setIsRecording(false);
          setIsProcessing(true);
          setStatusMessage('Transcribing and translating...');

          try {
            const response = await processAudio({
              audio: blob,
              sourceLanguage,
              targetLanguage
            });

            setSourceText(response.transcript || '');
            setTranslatedText(response.translatedText || '');
            setLatencyMs(response.latencyMs ?? null);
            setWarningMessage(response.warning || '');
            setStatusMessage('Completed. Review transcript and translation.');
            setErrorMessage('');
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Audio processing failed.';
            setErrorMessage(message);
            setStatusMessage('Request failed. Check API configuration.');
          } finally {
            setIsProcessing(false);
          }
        };

        recorder.start();
        setIsRecording(true);
      } catch (error) {
        cleanupStream();
        setIsRecording(false);
        const message = error instanceof Error ? error.message : 'Microphone permission denied.';
        setErrorMessage(message);
        setStatusMessage('Unable to start recording');
      }
    };

    const stopRecording = () => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        return;
      }

      recorder.stop();
    };

    const onTranslate = async () => {
      if (!sourceText.trim()) {
        setWarningMessage('Transcript is empty. Record audio or type text first.');
        return;
    }

      setIsTranslating(true);
      setErrorMessage('');
      setWarningMessage('');

      try {
        const response = await translateText({
          text: sourceText,
          sourceLanguage,
          targetLanguage
        });
        setTranslatedText(response.translatedText);
        setStatusMessage('Translation updated from OpenRouter.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Translation failed.';
        setErrorMessage(message);
        setStatusMessage('Translation failed');
      } finally {
        setIsTranslating(false);
    }
  };

  const onReset = () => {
    setSourceText('');
    setTranslatedText('');
      setIsRecording(false);
      setIsProcessing(false);
      setIsTranslating(false);
      setStatusMessage('Ready for recording');
      setWarningMessage('');
      setErrorMessage('');
      setLatencyMs(null);
      cleanupStream();
  };

  return (
      <Container size="lg" py="xl">
        <Stack gap="lg">
        <Paper className="hero" p="lg" withBorder>
          <Group justify="space-between" align="flex-start">
            <Stack gap={4}>
              <Title order={1}>{appTitle}</Title>
                <Text c="dimmed">End-to-end local testing for microphone, Deepgram STT, and Qwen3 translation via OpenRouter.</Text>
            </Stack>
              <Badge color={statusColor} variant="light" size="lg">
              {pipelineStatus}
            </Badge>
          </Group>
        </Paper>

          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Card withBorder padding="md">
              <Stack gap={4}>
                <Group gap="xs">
                  <ThemeIcon size="sm" color="teal" variant="light">
                    <IconCpu size={14} />
                  </ThemeIcon>
                  <Text fw={600}>Deepgram Model</Text>
                </Group>
                <Text>{healthState?.deepgramModel || deepgramModel}</Text>
              </Stack>
            </Card>

            <Card withBorder padding="md">
              <Stack gap={4}>
                <Group gap="xs">
                  <ThemeIcon size="sm" color="orange" variant="light">
                    <IconLanguage size={14} />
                  </ThemeIcon>
                  <Text fw={600}>OpenRouter Model</Text>
                </Group>
                <Text lineClamp={1}>{healthState?.openrouterModel || 'Not available'}</Text>
              </Stack>
            </Card>

            <Card withBorder padding="md">
              <Stack gap={4}>
                <Group gap="xs">
                  <ThemeIcon size="sm" color="blue" variant="light">
                    <IconSparkles size={14} />
                  </ThemeIcon>
                  <Text fw={600}>Last Latency</Text>
                </Group>
                <Text>{latencyMs ? `${latencyMs} ms` : 'No run yet'}</Text>
              </Stack>
            </Card>
          </SimpleGrid>

          {errorMessage ? (
            <Alert color="red" title="Action Required" icon={<IconAlertTriangle size={16} />}>
              {errorMessage}
            </Alert>
          ) : null}

          {warningMessage ? (
            <Alert color="yellow" title="Notice" icon={<IconAlertTriangle size={16} />}>
              {warningMessage}
            </Alert>
          ) : null}

          <Alert color="teal" title="Current Status" icon={<IconCircleCheck size={16} />}>
            {statusMessage}
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
                    onChange={(value) => setSourceLanguage(value || 'en')}
                    data={languageOptions}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <Select
                    label="Target language"
                    value={targetLanguage}
                    onChange={(value) => setTargetLanguage(value || 'hi')}
                    data={languageOptions.filter((option) => option.value !== sourceLanguage)}
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
            <Text fw={600}>Transcript (English)</Text>
            <Textarea
              value={sourceText}
              onChange={(event) => setSourceText(event.currentTarget.value)}
              minRows={5}
              autosize
              placeholder="Live transcript will appear here..."
            />
          </Stack>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Stack>
            <Group grow>
              <Button
                mt={25}
                onClick={onTranslate}
                color="ember"
                leftSection={<IconSparkles size={16} />}
                loading={isTranslating}
                disabled={isProcessing || isRecording}
              >
                Translate Transcript
              </Button>
            </Group>

            <Divider />

            <Stack gap="xs">
              <Text fw={600}>Translated output</Text>
              <Paper withBorder radius="md" p="sm" mih={110}>
                <Text>{translatedText || 'Translation will appear here once generated.'}</Text>
              </Paper>
            </Stack>
          </Stack>
        </Card>
      </Stack>
    </Container>
  );
}
