import React, { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  Heading,
  Input,
  Text,
  VStack,
  HStack,
  Progress,
  Modal,
  ModalBody,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalFooter,
  Select,
} from "@chakra-ui/react";

interface AudioContextRef {
  audioContext: AudioContext;
  analyser: AnalyserNode;
}

interface VoiceChatProps {
  roomId: string;
}

const VoiceChat: React.FC<VoiceChatProps> = ({ roomId: initialRoomId }) => {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isAudioOn, setIsAudioOn] = useState<boolean>(false);
  const [roomId, setRoomId] = useState<string>(initialRoomId || "");
  const [hasJoinedRoom, setHasJoinedRoom] = useState<boolean>(!!initialRoomId);
  const [remoteVolume, setRemoteVolume] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<string>("");
  const [remoteTranscript, setRemoteTranscript] = useState<string>("");
  const [callState, setCallState] = useState<
    "idle" | "calling" | "receiving" | "connected"
  >("idle");
  const [showIncomingCall, setShowIncomingCall] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string>("ko");
  // Refs
  const localAudioRef = useRef<HTMLAudioElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const webSocketRef = useRef<WebSocket | null>(null);
  const localAudioContextRef = useRef<AudioContextRef | null>(null);
  const remoteAudioContextRef = useRef<AudioContextRef | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingICECandidatesRef = useRef<RTCIceCandidate[]>([]);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const languages: any[] = [
    { code: "ko", label: "한국어" },
    { code: "en", label: "English" },
    { code: "zh", label: "中文" },
    { code: "ja", label: "日本語" },
  ];

  // WebRTC 연결 설정
  const createPeerConnection = (): RTCPeerConnection => {
    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" },
      ],
      iceTransportPolicy: "all",
      iceCandidatePoolSize: 10,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });

    peerConnection.onconnectionstatechange = () => {
      console.log("Connection State Changed:", peerConnection.connectionState);
    };

    peerConnection.oniceconnectionstatechange = () => {
      console.log("ICE Connection State:", peerConnection.iceConnectionState);
      if (peerConnection.iceConnectionState === "failed") {
        console.log("ICE 연결 실패 - 재시도");
        peerConnection.restartIce();
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && webSocketRef.current) {
        webSocketRef.current.send(
          JSON.stringify({
            type: "ice-candidate",
            candidate: event.candidate,
          })
        );
      }
    };

    peerConnection.ontrack = (event) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0];
        setupRemoteAudioAnalyser(event.streams[0]);
      }
    };

    return peerConnection;
  };

  // Whisper API 호출 함수
  const sendAudioToWhisper = async (audioBlob: Blob) => {
    const formData = new FormData();
    formData.append("model", "whisper-1");
    formData.append("file", audioBlob, "audio.webm");

    try {
      const response = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: import.meta.env.VITE_UNITY,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data.text) {
        setTranscript((prev) => prev + data.text + " ");
        // WebSocket으로 상대방에게 전송
        if (webSocketRef.current) {
          webSocketRef.current.send(
            JSON.stringify({
              type: "transcript",
              text: data.text,
            })
          );
        }
      }
    } catch (error) {
      console.error("Whisper API 오류:", error);
    }
  };

  // 녹음 시작 함수
  const startRecording = () => {
    if (!localStreamRef.current) return;

    const mediaRecorder = new MediaRecorder(localStreamRef.current);
    const audioChunks: Blob[] = [];
    let silenceTimeout: ReturnType<typeof setTimeout> | null = null;

    // 오디오 컨텍스트 설정
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(localStreamRef.current);
    source.connect(analyser);

    // 음성 감지를 위한 설정
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    // 음성 감지 함수
    const detectSilence = () => {
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / bufferLength;

      // 음성 감지 임계값을 50으로 높임 (기존 20)
      if (average > 30) {
        if (silenceTimeout) {
          clearTimeout(silenceTimeout);
        }
        silenceTimeout = setTimeout(async () => {
          if (mediaRecorder.state === "recording") {
            mediaRecorder.stop();
          }
        }, 1000); // 1초간 침묵 후 처리
      }

      if (mediaRecorder.state === "recording") {
        requestAnimationFrame(detectSilence);
      }
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
      await sendAudioToWhisper(audioBlob);
      audioChunks.length = 0;

      if (isAudioOn) {
        mediaRecorder.start();
        requestAnimationFrame(detectSilence);
      }
    };

    mediaRecorder.start();
    requestAnimationFrame(detectSilence);
    mediaRecorderRef.current = mediaRecorder;
    setIsRecording(true);
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  // 방 관리
  const joinRoom = (): void => {
    if (roomId.trim() === "") {
      alert("유효한 방 ID를 입력해주세요.");
      return;
    }

    const webSocket = new WebSocket(
      `wss://unbiased-evenly-worm.ngrok-free.app/voice-chat?roomId=${roomId}`
    );
    webSocketRef.current = webSocket;

    webSocket.onopen = () => {
      setIsConnected(true);
    };

    webSocket.onmessage = async (message: MessageEvent) => {
      const data = JSON.parse(message.data);

      switch (data.type) {
        case "transcript":
          setRemoteTranscript(data.text);
          break;
        case "call-request":
          setShowIncomingCall(true);
          setCallState("receiving");
          break;
        case "call-accept":
          setCallState("connected");
          await startCall();
          break;
        case "offer":
          await handleOffer(data.offer);
          break;
        case "answer":
          await handleAnswer(data.answer);
          break;
        case "ice-candidate":
          await handleNewICECandidateMsg(data.candidate);
          break;
        case "call-end":
          handleCallEnd();
          break;
      }
    };

    webSocket.onclose = () => {
      setIsConnected(false);
      handleCallEnd();
    };

    webSocket.onerror = () => {
      handleCallEnd();
    };

    setHasJoinedRoom(true);
  };

  // 통화 관리
  const requestCall = async (): Promise<void> => {
    if (!webSocketRef.current) return;

    setCallState("calling");
    webSocketRef.current.send(
      JSON.stringify({
        type: "call-request",
        roomId: roomId,
      })
    );
  };

  const acceptCall = async (): Promise<void> => {
    if (!webSocketRef.current) return;
    setShowIncomingCall(false);
    setCallState("connected");
    webSocketRef.current.send(
      JSON.stringify({
        type: "call-accept",
        roomId: roomId,
      })
    );

    await startCall();
  };

  const handleOffer = async (
    offer: RTCSessionDescriptionInit
  ): Promise<void> => {
    try {
      await cleanupExistingConnection();

      const peerConnection = createPeerConnection();
      peerConnectionRef.current = peerConnection;

      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (
        !peerConnection.signalingState ||
        peerConnection.signalingState === "closed"
      ) {
        throw new Error("Invalid connection state");
      }

      localStreamRef.current = localStream;
      localStream.getTracks().forEach((track) => {
        if (peerConnection.signalingState !== "closed") {
          peerConnection.addTrack(track, localStream);
        }
      });

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(offer)
      );

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      webSocketRef.current?.send(
        JSON.stringify({
          type: "answer",
          answer,
        })
      );
    } catch (error) {
      console.error("Offer handling error:", error);
      await cleanupExistingConnection();
    }
  };

  const handleAnswer = async (
    answer: RTCSessionDescriptionInit
  ): Promise<void> => {
    if (!peerConnectionRef.current) return;

    try {
      if (peerConnectionRef.current.signalingState === "stable") {
        console.log("Connection already in stable state, ignoring answer");
        return;
      }

      await peerConnectionRef.current.setRemoteDescription(
        new RTCSessionDescription(answer)
      );

      while (pendingICECandidatesRef.current.length > 0) {
        const candidate = pendingICECandidatesRef.current.shift();
        if (candidate) {
          await peerConnectionRef.current.addIceCandidate(candidate);
        }
      }
    } catch (error) {
      console.error("Error setting remote description:", error);
      handleCallEnd();
    }
  };

  const startCall = async (): Promise<void> => {
    try {
      await cleanupExistingConnection();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
        },
      });

      localStreamRef.current = stream;

      if (localAudioRef.current) {
        localAudioRef.current.srcObject = stream;
      }

      const peerConnection = createPeerConnection();
      peerConnectionRef.current = peerConnection;

      stream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, stream);
      });

      if (peerConnection.signalingState !== "stable") {
        console.warn("Connection not in stable state, waiting...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
      });

      await peerConnection.setLocalDescription(offer);

      webSocketRef.current?.send(
        JSON.stringify({
          type: "offer",
          offer: offer,
        })
      );
      setIsAudioOn(true);
    } catch (error) {
      console.error("통화 시작 중 오류:", error);
      handleCallEnd();
    }
  };

  const handleNewICECandidateMsg = async (
    candidate: RTCIceCandidateInit
  ): Promise<void> => {
    if (
      !peerConnectionRef.current ||
      !peerConnectionRef.current.remoteDescription
    ) {
      pendingICECandidatesRef.current.push(new RTCIceCandidate(candidate));
      return;
    }

    try {
      await peerConnectionRef.current.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    } catch (error) {
      console.error("Error adding ICE candidate:", error);
    }
  };

  const handleCallEnd = (): void => {
    cleanupCall();
    setCallState("idle");
  };

  const cleanupExistingConnection = async (): Promise<void> => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (localAudioContextRef.current?.audioContext?.state !== "closed") {
      await localAudioContextRef.current?.audioContext?.close();
    }
  };

  const cleanupCall = (): void => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localAudioRef.current) {
      localAudioRef.current.srcObject = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

    if (localAudioContextRef.current?.audioContext) {
      localAudioContextRef.current.audioContext.close();
    }
    if (remoteAudioContextRef.current?.audioContext) {
      remoteAudioContextRef.current.audioContext.close();
    }

    stopRecording();
    setIsAudioOn(false);
    setShowIncomingCall(false);
  };

  const endCall = (): void => {
    if (webSocketRef.current) {
      webSocketRef.current.send(
        JSON.stringify({
          type: "call-end",
          roomId: roomId,
        })
      );
    }
    handleCallEnd();
  };

  const toggleMute = (): void => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
    }
  };

  const setupRemoteAudioAnalyser = (stream: MediaStream): void => {
    if (remoteAudioContextRef.current?.audioContext) {
      remoteAudioContextRef.current.audioContext.close();
    }

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    remoteAudioContextRef.current = { audioContext, analyser };

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const updateVolume = () => {
      analyser.getByteFrequencyData(dataArray);
      const volume = dataArray.reduce((a, b) => a + b) / dataArray.length;
      setRemoteVolume(normalizeVolume(volume));
      if (isAudioOn) {
        requestAnimationFrame(updateVolume);
      }
    };

    updateVolume();
  };

  useEffect(() => {
    if (isAudioOn && !isRecording) {
      startRecording();
    } else if (!isAudioOn && isRecording) {
      stopRecording();
    }
  }, [isAudioOn]);

  useEffect(() => {
    if (initialRoomId) {
      joinRoom();
    }

    return () => {
      cleanupCall();
      if (webSocketRef.current) {
        webSocketRef.current.close();
      }
      if (recordingTimeoutRef.current) {
        clearInterval(recordingTimeoutRef.current);
      }
      stopRecording();
    };
  }, [initialRoomId]);

  const normalizeVolume = (volume: number): number => {
    const minDb = -60;
    const maxDb = 0;
    const normalized =
      (20 * Math.log10(volume / 255) - minDb) / (maxDb - minDb);
    return Math.max(0, Math.min(1, normalized)) * 100;
  };

  const handleLanguageChange = (newLanguage: string): void => {
    setSelectedLanguage(newLanguage);
    console.log("Language changed to:", newLanguage);

    if (isRecording) {
      stopRecording();
      setTimeout(() => {
        startRecording();
      }, 100);
    }
  };

  return (
    <Box
      w="20rem"
      bg="whiteAlpha.900"
      backdropFilter="blur(10px)"
      rounded="lg"
      overflow="hidden"
      shadow="lg"
      border="1px solid"
      borderColor="whiteAlpha.300"
    >
      <Flex
        p={3}
        bg="blue.500"
        alignItems="center"
        justifyContent="space-between"
      >
        <Heading size="sm" color="white">
          음성 채팅
        </Heading>
        {isConnected && (
          <Box
            px={2}
            py={0.5}
            fontSize="xs"
            bg="green.400"
            color="white"
            rounded="full"
          >
            연결됨
          </Box>
        )}
      </Flex>

      <VStack p={4} spacing={4}>
        {!hasJoinedRoom ? (
          <VStack spacing={3} w="full">
            <Input
              placeholder="방 ID 입력"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              size="sm"
              bg="whiteAlpha.200"
              borderColor="whiteAlpha.300"
              _placeholder={{ color: "whiteAlpha.600" }}
              focusBorderColor="blue.500"
            />
            <Button onClick={joinRoom} w="full" colorScheme="blue" size="md">
              방 입장
            </Button>
          </VStack>
        ) : (
          <VStack spacing={4} w="full">
            {callState === "idle" && (
              <Button
                onClick={requestCall}
                w="full"
                colorScheme="green"
                size="md"
              >
                통화 시작
              </Button>
            )}
            {callState === "calling" && (
              <VStack spacing={2} w="full">
                <Text fontSize="sm" textAlign="center">
                  응답 대기중...
                </Text>
                <Button
                  onClick={cleanupCall}
                  w="full"
                  colorScheme="gray"
                  size="md"
                >
                  취소
                </Button>
              </VStack>
            )}
            {callState === "connected" && (
              <HStack spacing={2} w="full">
                <Button
                  onClick={toggleMute}
                  flex="1"
                  colorScheme="blue"
                  size="md"
                >
                  {isMuted ? "음성 켜기" : "음성 끄기"}
                </Button>
                <Button onClick={endCall} flex="1" colorScheme="red" size="md">
                  통화 종료
                </Button>
              </HStack>
            )}
            {isAudioOn && (
              <>
                <Box w="full">
                  <Text fontSize="xs" mb={1}>
                    상대방 음성
                  </Text>
                  <Progress
                    value={remoteVolume}
                    size="xs"
                    colorScheme="green"
                  />
                </Box>
                <Box w="full">
                  <Text fontSize="xs" mb={1}>
                    음성 인식 언어
                  </Text>
                </Box>{" "}
                <Select
                  value={selectedLanguage}
                  onChange={(e) => handleLanguageChange(e.target.value)}
                  size="sm"
                >
                  {languages.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </Select>
                <VStack spacing={3} w="full">
                  <Box w="full">
                    <Flex justifyContent="space-between" mb={1}>
                      <Text fontSize="xs">내 스크립트</Text>
                      <Button
                        onClick={() => setTranscript("")}
                        size="xs"
                        variant="link"
                      >
                        지우기
                      </Button>
                    </Flex>
                    <Box
                      p={3}
                      bg="whiteAlpha.200"
                      rounded="md"
                      h="8rem"
                      overflowY="auto"
                    >
                      {transcript || "음성 입력 대기중..."}
                    </Box>
                  </Box>
                  <Box w="full">
                    <Flex justifyContent="space-between" mb={1}>
                      <Text fontSize="xs">상대방 스크립트</Text>
                      <Button
                        onClick={() => setRemoteTranscript("")}
                        size="xs"
                        variant="link"
                      >
                        지우기
                      </Button>
                    </Flex>
                    <Box
                      p={3}
                      bg="whiteAlpha.200"
                      rounded="md"
                      h="8rem"
                      overflowY="auto"
                    >
                      {remoteTranscript || "상대방 음성 입력 대기중..."}
                    </Box>
                  </Box>
                </VStack>
              </>
            )}
          </VStack>
        )}
      </VStack>

      {showIncomingCall && (
        <Modal isOpen={showIncomingCall} onClose={cleanupCall}>
          <ModalOverlay />
          <ModalContent>
            <ModalHeader>수신 통화</ModalHeader>
            <ModalBody>
              <Text mb={4}>누군가가 연결을 시도 중입니다.</Text>
            </ModalBody>
            <ModalFooter>
              <HStack spacing={4}>
                <Button onClick={cleanupCall} colorScheme="gray">
                  거절
                </Button>
                <Button onClick={acceptCall} colorScheme="green">
                  수락
                </Button>
              </HStack>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}

      <Box display="none">
        <audio ref={localAudioRef} autoPlay muted />
        <audio ref={remoteAudioRef} autoPlay />
      </Box>
    </Box>
  );
};

export default VoiceChat;
