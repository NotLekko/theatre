// Stands in for @picovoice/pvrecorder-node in tests: yields alternating frames of
// +0.5 and -0.5, one every 5 ms, and records the lifecycle calls it receives.
const fs = require("node:fs");

const log = (event) => fs.appendFileSync(process.env.FAKE_PVRECORDER_LOG, `${event}\n`);

class PvRecorder {
  constructor(frameLength, deviceIndex) {
    this.frameLength = frameLength;
    this.frames = 0;
    log(`open ${frameLength} ${deviceIndex}`);
  }
  start() {
    log("start");
  }
  getSelectedDevice() {
    return "Fake Microphone";
  }
  readSync() {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    return new Int16Array(this.frameLength).fill(this.frames++ % 2 === 0 ? 16384 : -16384);
  }
  stop() {
    log("stop");
  }
  release() {
    log("release");
  }
}

module.exports = { PvRecorder };
