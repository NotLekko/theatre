// Runs PvRecorder on its own thread. Its reads block until the next audio frame arrives
// (every 32 ms), which would otherwise stall the terminal and the streaming replies.
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import type { PvRecorder as PvRecorderClass } from "@picovoice/pvrecorder-node";

export type RecorderMessage =
  | { type: "ready"; name: string }
  | { type: "audio"; frame: Int16Array }
  | { type: "error"; message: string };

const { deviceIndex, stop, recorderModule } = workerData as {
  deviceIndex: number;
  stop: Int32Array;
  recorderModule: string;
};
const port = parentPort!;
const send = (message: RecorderMessage, transfer: ArrayBuffer[] = []) => port.postMessage(message, transfer);

let recorder: PvRecorderClass | undefined;
try {
  const { PvRecorder } = createRequire(import.meta.url)(recorderModule) as {
    PvRecorder: typeof PvRecorderClass;
  };
  recorder = new PvRecorder(512, deviceIndex);
  recorder.start();
  send({ type: "ready", name: recorder.getSelectedDevice() });
  // The main thread sets the flag to stop; it's checked after every frame.
  while (Atomics.load(stop, 0) === 0) {
    const frame = recorder.readSync();
    send({ type: "audio", frame }, [frame.buffer as ArrayBuffer]);
  }
} catch (err) {
  send({ type: "error", message: (err as Error).message });
} finally {
  if (recorder) {
    try {
      recorder.stop();
    } catch {
      // Already stopped.
    }
    recorder.release();
  }
}
