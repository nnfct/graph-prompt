const j = (r) => r.json()

export const listGraphs = () => fetch('/api/graphs').then(j)
export const loadGraph = (file) => fetch(`/api/graph?file=${encodeURIComponent(file)}`).then(j)
export const saveGraph = (file, md) =>
  fetch('/api/graph', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, md }) }).then(j)
export const startRun = (md, name) =>
  fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ md, name }) }).then(j)
export const cancelRun = (runId) =>
  fetch('/api/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId }) }).then(j)
export const listRuns = () => fetch('/api/runs').then(j)
export const loadRunFile = (file) => fetch(`/api/run-file?file=${encodeURIComponent(file)}`).then(j)
export const draft = (instruction, md) =>
  fetch('/api/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction, md }) }).then(j)
export const optimize = (instruction, md, name) =>
  fetch('/api/optimize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction, md, name }) }).then(j)

export function streamRun(runId, onRec, onEnd) {
  const es = new EventSource(`/api/stream/${runId}`)
  es.onmessage = (e) => {
    const rec = JSON.parse(e.data)
    onRec(rec)
    if (rec.kind === 'child:exit') { es.close(); onEnd?.(rec) }
  }
  es.onerror = () => { es.close(); onEnd?.(null) }
  return () => es.close()
}
