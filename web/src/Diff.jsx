import { useMemo } from 'react'
import { diffLines } from 'diff'
import { Distribution } from './Trace.jsx'

const fmt$ = (c) => (c == null ? '—' : `$${c.toFixed(2)}`)
const lastByNode = (trace) => {
  const m = new Map()
  for (const t of trace) if (t.kind !== 'loop' && t.type !== 'loop' && !t.skipped) m.set(t.node, t)
  return m
}

function Summary({ run }) {
  const s = run.summary
  return (
    <div className="tmeta">
      {(s.ms / 60000).toFixed(1)}분 · {fmt$(s.cost)} · out {(s.tokens?.out ?? 0).toLocaleString()}tok
      {s.failed?.length ? ` · 실패 [${s.failed.join(',')}]` : ''}
      {s.skipped?.length ? ` · 스킵 [${s.skipped.join(',')}]` : ''}
    </div>
  )
}

// run 2개 비교: 요약 / 노드별 대조 / 최종 출력 / 그래프 MD diff
export default function Diff({ a, b }) {
  const [na, nb] = [lastByNode(a.trace), lastByNode(b.trace)]
  const allNodes = [...new Set([...na.keys(), ...nb.keys()])]
  const mdDiff = useMemo(
    () => (a.graphMd && b.graphMd ? diffLines(a.graphMd, b.graphMd) : null),
    [a, b]
  )
  const final = (m) => {
    const ids = [...m.keys()]
    const t = m.get(ids[ids.length - 1])
    return t?.parsed ? JSON.stringify(t.parsed, null, 2) : t?.raw || '(없음)'
  }
  return (
    <div>
      <div className="diffcols">
        <div><h4>{a.label}</h4><Summary run={a} /></div>
        <div><h4>{b.label}</h4><Summary run={b} /></div>
      </div>

      <h4 style={{ margin: '14px 0 6px' }}>노드별 대조 (마지막 iter 기준)</h4>
      <table className="dist">
        <tbody>
          {allNodes.map((id) => {
            const [ta, tb] = [na.get(id), nb.get(id)]
            return (
              <tr key={id}>
                <td className="mono">{id}</td>
                <td style={{ color: ta ? undefined : '#f85149' }}>{ta ? `${(ta.ms / 1000).toFixed(0)}s · ${fmt$(ta.cost)} · ${ta.tokens?.out ?? 0}tok` : '없음'}</td>
                <td style={{ color: tb ? undefined : '#f85149' }}>{tb ? `${(tb.ms / 1000).toFixed(0)}s · ${fmt$(tb.cost)} · ${tb.tokens?.out ?? 0}tok` : '없음'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="diffcols" style={{ marginTop: 14 }}>
        <div><h4>비용 분포</h4><Distribution trace={a.trace} /></div>
        <div><h4>비용 분포</h4><Distribution trace={b.trace} /></div>
      </div>

      <div className="diffcols" style={{ marginTop: 14 }}>
        <div><h4>최종 출력</h4><pre style={{ maxHeight: 400, overflow: 'auto' }} className="mono">{final(na)}</pre></div>
        <div><h4>최종 출력</h4><pre style={{ maxHeight: 400, overflow: 'auto' }} className="mono">{final(nb)}</pre></div>
      </div>

      {mdDiff && (
        <>
          <h4 style={{ margin: '14px 0 6px' }}>그래프 MD diff (A → B)</h4>
          <pre className="mono">
            {mdDiff.map((p, i) => (
              <span key={i} className={p.added ? 'dline-add' : p.removed ? 'dline-del' : ''}>
                {p.value.split('\n').filter((l, j, arr) => l || j < arr.length - 1)
                  .map((l) => `${p.added ? '+' : p.removed ? '-' : ' '} ${l}`).join('\n') + '\n'}
              </span>
            ))}
          </pre>
        </>
      )}
      {!mdDiff && <div className="hint" style={{ marginTop: 10 }}>그래프 MD 미동봉 run — diff 생략 (구버전 run 파일)</div>}
    </div>
  )
}
