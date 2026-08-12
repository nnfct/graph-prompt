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
              <span className="tnode">{t.node}</span>
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

export function Distribution({ trace }) {
  const rows = useMemo(() => {
    const by = new Map()
    for (const t of trace) {
      if (t.kind === 'loop' || t.type === 'loop' || t.skipped) continue
      const r = by.get(t.node) || { node: t.node, ms: 0, cost: 0, out: 0, iters: 0 }
      r.ms += t.ms || 0; r.cost += t.cost || 0; r.out += t.tokens?.out || 0; r.iters += 1
      by.set(t.node, r)
    }
    return [...by.values()].sort((a, b) => b.cost - a.cost)
  }, [trace])
  const total = rows.reduce((a, r) => a + r.cost, 0) || 1
  return (
    <table className="dist">
      <tbody>
        {rows.map((r) => (
          <tr key={r.node}>
            <td className="mono">{r.node}</td>
            <td>{r.iters}회</td>
            <td>{fmtS(r.ms)}</td>
            <td>{fmt$(r.cost)}</td>
            <td>{r.out.toLocaleString()}tok</td>
            <td style={{ width: 200 }}><div className="bar" style={{ width: `${(r.cost / total) * 100}%` }} /></td>
            <td>{Math.round((r.cost / total) * 100)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
