import { useMemo, useState } from 'react'

const fmt$ = (c) => (c == null ? '—' : `$${c.toFixed(3)}`)
const fmtS = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`)

function NodeDetail({ t }) {
  const [tab, setTab] = useState('out')
  const tabs = [
    ['out', '출력'], ['prompt', '발송 프롬프트'], ['src', `근거 ${(t.sources || []).length}`],
    ...(t.lensRuns ? [['lens', `렌즈 ${t.lensRuns.length}`]] : []),
    ...(t.stderr ? [['err', 'stderr']] : []),
  ]
  return (
    <div className="tdetail">
      <div className="tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'out' && <pre>{t.parsed ? JSON.stringify(t.parsed, null, 2) : t.raw || '(없음)'}</pre>}
      {tab === 'prompt' && <pre>{t.promptSent || (t.lensRuns ? '렌즈별 프롬프트는 "렌즈" 탭' : '(기록 없음 — 구버전 run)')}</pre>}
      {tab === 'src' && (
        <ul className="srcchain">
          {(t.sources || []).map((s, i) => (
            <li key={i}>
              <b>{s.from}</b> — {typeof s.claim === 'string' ? s.claim : JSON.stringify(s.claim)}
            </li>
          ))}
          {!(t.sources || []).length && <li>(근거 체인 없음)</li>}
        </ul>
      )}
      {tab === 'lens' && t.lensRuns?.map((lr, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <b>[{lr.lens}]</b> {lr.ok ? '완료' : '실패'} · {fmtS(lr.ms)} · {fmt$(lr.cost)}
          <pre>{lr.parsed ? JSON.stringify(lr.parsed, null, 2) : lr.raw}</pre>
          {lr.prompt && <details><summary className="hint">발송 프롬프트</summary><pre>{lr.prompt}</pre></details>}
        </div>
      ))}
      {tab === 'err' && <pre>{t.stderr}</pre>}
    </div>
  )
}

export function TraceList({ trace }) {
  const [open, setOpen] = useState(null)
  const cp = useMemo(() => criticalPath(trace), [trace])
  const maxMs = Math.max(1, ...trace.filter((t) => t.kind !== 'loop').map((t) => t.ms || 0))
  return (
    <div>
      {trace.map((t, i) =>
        t.kind === 'loop' || t.type === 'loop' ? (
          <div key={i} className="trow" style={{ borderStyle: 'dashed' }}>
            <div className="thead">
              <span className="tnode" style={{ color: '#d29922' }}>↻ {t.node}</span>
              <span className="tmeta">iter {t.iter} · {t.repeat ? '재실행' : '종료'} — {t.why}{t.cost ? ` · judge ${fmt$(t.cost)}` : ''}</span>
            </div>
          </div>
        ) : (
          <div key={i} className="trow">
            <div className="thead" onClick={() => setOpen(open === i ? null : i)}>
              <span className="tnode">{cp.has(t) ? '⚡' : ''}{t.node}</span>
              <span className="tmeta">
                {t.type} · iter {t.iter} · {t.skipped ? '스킵' : t.ok ? '완료' : '실패'}
                {t.degraded ? ' · degraded' : ''} · {fmtS(t.ms)} · {fmt$(t.cost)} · out {(t.tokens?.out ?? 0).toLocaleString()}tok
              </span>
              <div className="bar" style={{ width: `${((t.ms || 0) / maxMs) * 160}px`, marginLeft: 'auto' }} />
            </div>
            {open === i && <NodeDetail t={t} />}
          </div>
        )
      )}
    </div>
  )
}

// 크리티컬 패스: 전체 wall-clock 을 결정한 레코드 체인.
// 각 레코드 start = at - ms. 가장 늦게 끝난 레코드에서 시작해,
// "내 시작 직전에 끝난" 입력(또는 직전 레코드)을 따라 거슬러 오른다.
export function criticalPath(trace) {
  const recs = trace.filter((t) => t.kind !== 'loop' && t.type !== 'loop' && !t.skipped)
  if (!recs.length) return new Set()
  const path = new Set()
  let cur = recs.reduce((a, b) => (b.at > a.at ? b : a))
  while (cur) {
    path.add(cur)
    const start = cur.at - (cur.ms || 0)
    const cands = recs.filter((r) => r !== cur && r.at <= start + 1500 && !path.has(r))
    if (!cands.length) break
    const inputs = cands.filter((r) => (cur.inputs || []).includes(r.node))
    const pool = inputs.length ? inputs : cands
    cur = pool.reduce((a, b) => (b.at > a.at ? b : a))
    if (cur.at < start - 60000) break // 병렬로 훨씬 먼저 끝난 노드는 경로가 아니다
  }
  return path
}

export function Distribution({ trace }) {
  const cp = useMemo(() => criticalPath(trace), [trace])
  const cpNodes = new Set([...cp].map((t) => `${t.node}#${t.iter}`))
  const rows = useMemo(() => {
    const by = new Map()
    for (const t of trace) {
      if (t.kind === 'loop' || t.type === 'loop' || t.skipped) continue
      const r = by.get(t.node) || { node: t.node, ms: 0, cost: 0, out: 0, iters: 0, cpMs: 0 }
      r.ms += t.ms || 0; r.cost += t.cost || 0; r.out += t.tokens?.out || 0; r.iters += 1
      if (cp.has(t)) r.cpMs += t.ms || 0
      by.set(t.node, r)
    }
    return [...by.values()].sort((a, b) => b.cpMs - a.cpMs || b.cost - a.cost)
  }, [trace, cp])
  const total = rows.reduce((a, r) => a + r.cost, 0) || 1
  const cpTotal = rows.reduce((a, r) => a + r.cpMs, 0) || 1
  return (
    <table className="dist">
      <tbody>
        {rows.map((r) => (
          <tr key={r.node}>
            <td className="mono">{r.cpMs > 0 ? '⚡' : ''}{r.node}</td>
            <td>{r.iters}회</td>
            <td>{fmtS(r.ms)}</td>
            <td>{fmt$(r.cost)}</td>
            <td>{r.out.toLocaleString()}tok</td>
            <td style={{ width: 160 }}>
              <div className="bar" style={{ width: `${(r.cpMs / cpTotal) * 100}%`, background: r.cpMs ? '#d29922' : '#30363d' }} title="wall-clock 기여" />
            </td>
            <td title="전체 시간 중 이 노드가 결정한 몫">{r.cpMs ? `${Math.round((r.cpMs / cpTotal) * 100)}%` : '—'}</td>
          </tr>
        ))}
        <tr><td colSpan={7} className="hint">⚡ = 크리티컬 패스 (전체 시간을 결정한 체인). 이 노드들을 줄여야 빨라진다 — 나머지는 줄여도 그대로.</td></tr>
      </tbody>
    </table>
  )
}
