/**
 * `deviceId` pins a specific input (over the browser/OS default) — matters
 * because the default device is a common silent-failure source: audio
 * capture succeeds and produces real samples, just from the wrong mic
 * (muted built-in mic while a Bluetooth headset is connected, an unplugged
 * external mic still set as default, etc).
 */
export async function getMicStream(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  });
}

export interface MicrophoneOption {
  deviceId: string;
  label: string;
}

/**
 * Device labels are blank until mic permission has been granted at least
 * once in this browser — before that, callers just get generic "Microphone
 * 1"-style fallback labels below.
 */
export async function listMicrophones(): Promise<MicrophoneOption[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
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
