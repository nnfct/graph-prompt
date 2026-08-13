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

// 스트리밍 draft/최적화: onRec({t}|{think}) 반복 → 마지막 {done:true,...} 반환
export async function streamGen(path, body, onDelta) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let final = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
      if (!chunk.startsWith('data: ')) continue
      const rec = JSON.parse(chunk.slice(6))
      if (rec.done) final = rec
      else onDelta(rec)
    }
  }
  return final || { error: '스트림 중단' }
}

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
