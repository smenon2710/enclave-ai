export async function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

export function isDisplayAudioCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/**
 * Captures remote/system audio via a tab or screen share. Returns null (not
 * an error) when the platform doesn't support audio sharing or the user
 * shared a source without audio — both are expected fallback-to-mic-only
 * cases, not failures.
 */
export async function getParticipantsStream(): Promise<MediaStream | null> {
  if (!isDisplayAudioCaptureSupported()) {
    return null;
  }

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  const audioTracks = displayStream.getAudioTracks();
  displayStream.getVideoTracks().forEach((track) => track.stop());

  if (audioTracks.length === 0) {
    return null;
  }

  return new MediaStream(audioTracks);
}
