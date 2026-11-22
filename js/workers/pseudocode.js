/* 3S Compilator : worker « Algorithme » (pseudocode). Protocole : voir shared.js. */
importScripts('shared.js', '../engines/pseudocode.js');

self.onmessage = ({ data }) => {
  if (data.cmd !== 'run') return;
  const out = self.ThreeS.createOutput();
  self.postMessage({ type: 'start' });
  const r = self.Pseudocode.runPseudocode(data.code, {
    readLine: self.ThreeS.createInput(data.input, out),
    trace: data.trace,
    maxTraceSteps: self.ThreeS.TRACE_LIMIT,
    onOutput: (text) => out.write(text),
  });
  out.flush();
  self.postMessage({ type: 'end', error: r.error, output: r.output, steps: r.steps, truncated: r.truncated });
};
