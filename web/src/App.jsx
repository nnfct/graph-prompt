import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import { parseGraph, serializeGraph } from '../../server/parse.mjs'
import Canvas from './Canvas.jsx'
import { TraceList, Distribution } from './Trace.jsx'
import Diff from './Diff.jsx'
import * as api from './api.js'

const runLabel = (f) => f.replace(/\.json$/, '')

export default function App() {
  const [files, setFiles] = useState([])
  const [file, setFile] = useState(null)
  const [md, setMd] = useState('')
  const [statuses, setStatuses] = useState({}) // nodeId → {status, iter, ms, cost}
  const [liveRun, setLiveRun] = useState(null) // {runId, events}
  const [runs, setRuns] = useState([])
  const [selected, setSelected] = useState([]) // 선택된 run file 목록 (1=trace, 2=diff)
  const [drawer, setDrawer] = useState(null) // {mode:'trace'|'diff'|'live', ...}
  const [nl, setNl] = useState('')
  const [busy, setBusy] = useState(false)
  const [proposal, setProposal] = useState(null) // 최적화 제안 {md, rationale}
  const stopStream = useRef(null)

  const graph = useMemo(() => parseGraph(md), [md])

  const refreshRuns = useCallback(() => api.listRuns().then((r) => setRuns(r.finished)), [])
  useEffect(() => {
    api.listGraphs().then((fs) => { setFiles(fs); if (fs[0]) pick(fs[0]) })
    refreshRuns()
  }, [])

  const pick = (f) => { setFile(f); api.loadGraph(f).then((r) => setMd(r.md)) }

  // 캔버스 → 그래프(정본) → MD 재직렬화
  const mutate = useCallback((fn) => {
    setMd((cur) => {
      const g = parseGraph(cur)
      if (g.errors.length) return cur // 깨진 MD 위에 구조 편집 금지
      fn(g)
      return serializeGraph(g)
    })
  }, [])
  const onMove = useCallback((id, pos) => mutate((g) => { const n = g.nodes.find((n) => n.id === id); if (n) n.pos = pos }), [mutate])
  const onConnect = useCallback((from, to) => mutate((g) => {
    const n = g.nodes.find((n) => n.id === from)
    if (!n || n.next.includes(to)) return
    n.next.push(to)
    const a = n.attrs.find((a) => a.k === 'next')
    if (a) a.v = n.next.join(', ')
    else n.attrs.push({ k: 'next', v: n.next.join(', '), block: false })
  }), [mutate])
  const addNode = () => mutate((g) => {
    let i = 1; while (g.nodes.some((n) => n.id === `node${i}`)) i++
    g.nodes.push({ id: `node${i}`, type: 'claude', attrs: [{ k: 'prompt', v: '지시를 쓴다', block: false }], prompt: '지시를 쓴다', out: '', lens: [], next: [], inExplicit: [], in: [], loop: null, pos: [80, 80 + g.nodes.length * 60] })
  })

  const save = () => file && api.saveGraph(file, md)

  const run = async () => {
    if (graph.errors.length || busy) return
    setBusy(true)
    await save()
    const name = file.replace(/\.md$/, '')
    const r = await api.startRun(md, name)
    setBusy(false)
    if (r.errors) return alert('그래프 오류:\n' + r.errors.join('\n'))
    const events = []
    setStatuses(Object.fromEntries(graph.nodes.map((n) => [n.id, { status: 'pending', iter: 0 }])))
    setLiveRun({ runId: r.runId, name })
    setDrawer(null)
    stopStream.current = api.streamRun(r.runId, (rec) => {
      events.push(rec)
      if (rec.kind === 'live' && rec.type === 'node:start') setStatuses((s) => ({ ...s, [rec.node]: { ...s[rec.node], status: 'running', iter: rec.iter } }))
      if (rec.kind === 'live' && rec.type === 'node:skipped') setStatuses((s) => ({ ...s, [rec.node]: { ...s[rec.node], status: 'skipped' } }))
      if (rec.kind === 'node') setStatuses((s) => ({ ...s, [rec.node]: { status: rec.skipped ? 'skipped' : rec.ok ? 'done' : 'failed', iter: rec.iter, ms: rec.ms, cost: rec.cost } }))
      if (rec.kind === 'live' && rec.type === 'loop' && rec.repeat) {
        setStatuses((s) => { const c = { ...s }; for (const k in c) if (c[k].status === 'pending') c[k] = { ...c[k], status: 'pending' }; return c })
      }
      setLiveRun((lr) => lr && { ...lr, tick: events.length })
    }, () => { setLiveRun(null); refreshRuns() })
  }

  const cancel = () => liveRun && api.cancelRun(liveRun.runId)

  const doDraft = async () => {
    if (!nl.trim() || busy) return
    setBusy(true)
    const r = await api.draft(nl, md)
    setBusy(false)
    if (r.error) return alert(r.error)
    if (r.errors?.length) return alert('draft 결과에 오류 — 반영 안 함:\n' + r.errors.join('\n'))
    setMd(r.md)
    setNl('')
  }

  // 할 일(입력창 텍스트, 없어도 됨) + 현재 그래프 + 최신 run 실측 → 최적 구조 제안
  const doOptimize = async () => {
    if (busy) return
    setBusy(true)
    const r = await api.optimize(nl, md, file?.replace(/\.md$/, ''))
    setBusy(false)
    if (r.error) return alert(r.error + (r.raw ? '\n\n' + r.raw : ''))
    if (r.errors?.length) return alert('제안 그래프에 오류 — 반영 안 함:\n' + r.errors.join('\n'))
    setProposal(r) // 바로 덮어쓰지 않는다 — 근거 보고 적용/취소
  }

  const toggleRun = (f) => setSelected((s) => (s.includes(f) ? s.filter((x) => x !== f) : [...s.slice(-1), f]))
  const openTrace = async () => {
    if (selected.length === 1) {
      const d = await api.loadRunFile(selected[0])
      setDrawer({ mode: 'trace', label: runLabel(selected[0]), data: d })
    } else if (selected.length === 2) {
      const [a, b] = await Promise.all(selected.map(api.loadRunFile))
      setDrawer({ mode: 'diff', a: { ...a, label: runLabel(selected[0]) }, b: { ...b, label: runLabel(selected[1]) } })
    }
  }
  useEffect(() => { if (selected.length) openTrace(); else setDrawer(null) }, [selected])

  return (
    <div className="app">
      <div className="topbar">
        <span className="title">graph-prompt</span>
        <select value={file || ''} onChange={(e) => pick(e.target.value)}>
          {files.map((f) => <option key={f}>{f}</option>)}
        </select>
        <button onClick={addNode}>+ 노드</button>
        <button onClick={save}>저장</button>
        <span className="hint" style={{ marginLeft: 'auto' }}>
          {graph.nodes.length}노드 · {graph.edges.length}엣지 {graph.errors.length ? `· 오류 ${graph.errors.length}` : ''}
        </span>
        {liveRun
          ? <button className="danger" onClick={cancel}>■ 중단</button>
          : <button className="primary" onClick={run} disabled={!!graph.errors.length || busy}>▶ 실행 (Ctrl+Enter)</button>}
      </div>

      <div className="main">
        <div className="editor-pane">
          {graph.errors.length > 0 && <div className="errors">{graph.errors.join('\n')}</div>}
          <CodeMirror
            value={md} theme={oneDark} extensions={[markdown()]} height="100%"
            onChange={setMd} style={{ flex: 1, minHeight: 0 }}
            onKeyDown={(e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); run() } }}
          />
        </div>
        <div className="canvas-pane" tabIndex={0}
          onKeyDown={(e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); run() } }}>
          <Canvas graph={graph} statuses={statuses} onMove={onMove} onConnect={onConnect} />
        </div>
      </div>

      <div className="bottombar">
        <input
          placeholder='자연어로 그래프 초안/수정 — 예: "리서치 갈래 하나 더 추가하고 redteam 을 score 앞으로" (Enter)'
          value={nl} onChange={(e) => setNl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doDraft()}
        />
        <button onClick={doDraft} disabled={busy}>{busy ? '…' : 'AI draft'}</button>
        <button onClick={doOptimize} disabled={busy} title="할 일(입력창) + 현재 그래프 + 최신 run 실측으로 구조를 재설계">
          {busy ? '…' : '⚡ 최적화'}
        </button>
      </div>

      {proposal && (
        <div className="proposal">
          <div className="phead">
            <b>⚡ 최적화 제안</b>
            <button className="primary" onClick={() => { setMd(proposal.md); setProposal(null); setNl('') }}>적용</button>
            <button onClick={() => setProposal(null)}>취소</button>
          </div>
          <div className="prationale">{proposal.rationale}</div>
          <details><summary className="hint">제안 그래프 MD 미리보기</summary><pre className="mono">{proposal.md}</pre></details>
        </div>
      )}

      <div className="runstack">
        {liveRun && (
          <div className="runcard selected" onClick={() => setDrawer({ mode: 'live' })}>
            <div className="rname rlive">● {liveRun.name} 실행 중</div>
            <div className="rmeta">{Object.values(statuses).filter((s) => s.status === 'done').length}/{graph.nodes.length} 노드 완료</div>
          </div>
        )}
        {runs.map((r) => (
          <div key={r.file} className={`runcard ${selected.includes(r.file) ? 'selected' : ''}`} onClick={() => toggleRun(r.file)}>
            <div className="rname">{runLabel(r.file)}</div>
            <div className="rmeta">{(r.size / 1024).toFixed(0)}KB · {new Date(r.mtime).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
            <div className="rmeta hint">{selected.includes(r.file) ? '선택됨 — 2개 선택 시 diff' : '클릭: 트레이스'}</div>
          </div>
        ))}
        {!runs.length && !liveRun && <span className="hint">아직 run 없음 — 그래프 짜고 Ctrl+Enter</span>}
      </div>

      {drawer && (
        <div className="drawer">
          <div className="dhead">
            <b>{drawer.mode === 'diff' ? `diff: ${drawer.a.label} ↔ ${drawer.b.label}` : drawer.mode === 'live' ? '실행 중 (캔버스에 실시간 표시)' : drawer.label}</b>
            <button style={{ marginLeft: 'auto' }} onClick={() => { setDrawer(null); setSelected([]) }}>닫기</button>
          </div>
          <div className="dbody">
            {drawer.mode === 'trace' && (
              <>
                <h4 style={{ marginBottom: 6 }}>비용·시간 분포</h4>
                <Distribution trace={drawer.data.trace} />
                <h4 style={{ margin: '14px 0 6px' }}>노드별 트레이스</h4>
                <TraceList trace={drawer.data.trace} />
              </>
            )}
            {drawer.mode === 'diff' && <Diff a={drawer.a} b={drawer.b} />}
            {drawer.mode === 'live' && <div className="hint">노드 색: 회색=대기 · 노랑=실행중 · 초록=완료 · 빨강=실패. 완료되면 run 카드가 스택에 추가된다.</div>}
          </div>
        </div>
      )}
    </div>
  )
}
