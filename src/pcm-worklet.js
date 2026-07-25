// Taps the video's audio: passes it straight through to the speakers (so the
// user still hears it) while posting a downmixed-to-mono PCM copy to the main
// thread in ~4096-sample batches for the ring buffer.
class YLRPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._pending = [];
    this._count = 0;
    this._target = 4096;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    const ch0 = input[0];
    const ch1 = input[1];
    const n = ch0.length;

    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];

    if (output && output.length) {
      for (let c = 0; c < output.length; c++) {
        const oc = output[c];
        const ic = input[c] || input[0];
        for (let i = 0; i < oc.length; i++) oc[i] = ic[i];
      }
    }

    this._pending.push(mono);
    this._count += n;
    if (this._count >= this._target) {
      const merged = new Float32Array(this._count);
      let o = 0;
      for (const b of this._pending) {
        merged.set(b, o);
        o += b.length;
      }
      this.port.postMessage(merged, [merged.buffer]);
      this._pending = [];
      this._count = 0;
    }
    return true;
  }
}

registerProcessor("ylr-pcm", YLRPCMProcessor);
