import { useCallback, useMemo } from 'react'
import { ReactFlow, Background, Controls, Handle, Position } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

const TYPE_COLOR = { claude: '#4493f8', codex: '#3fb950', research: '#d29922', 'red-team': '#f85149' }

function GNode({ data }) {
  const n = data.node
  const st = data.status
  return (
    <div className={`gnode st-${st?.status || 'pending'}`}>
      <Handle type="target" position={Position.Left} />
      <div>
        <span className="nid">{n.id}</span>
        <span className="ntype" style={{ color: TYPE_COLOR[n.type] }}>{n.type}</span>
        {n.lens.length > 1 && <span className="ntype">lens×{n.lens.length}</span>}
      </div>
      <div className="nprompt">{n.prompt}</div>
      {n.loop && <div className="loopbadge">↻ {n.loop.kind} max={n.loop.max} → {n.loop.target}</div>}
      {st?.iter > 0 && (
        <div className="nmeta">
          iter {st.iter}{st.ms ? ` · ${(st.ms / 1000).toFixed(1)}s` : ''}{st.cost ? ` · $${st.cost.toFixed(2)}` : ''}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
const nodeTypes = { gnode: GNode }

// graph(파싱 결과) → React Flow. 드래그 종료 시 좌표만 그래프에 반영.
export default function Canvas({ graph, statuses, onMove, onConnect }) {
  const nodes = useMemo(
    () =>
      graph.nodes.map((n, i) => ({
        id: n.id,
        type: 'gnode',
        position: { x: n.pos?.[0] ?? 80 + (i % 3) * 260, y: n.pos?.[1] ?? 60 + Math.floor(i / 3) * 150 },
        data: { node: n, status: statuses[n.id] },
      })),
    [graph, statuses]
  )
  const edges = useMemo(
    () => [
      ...graph.edges.map((e) => ({
        id: `${e.from}-${e.to}`, source: e.from, target: e.to,
        animated: statuses[e.to]?.status === 'running',
        style: { stroke: '#4493f8' },
      })),
      ...graph.nodes.filter((n) => n.loop && n.loop.target !== n.id).map((n) => ({
        id: `loop-${n.id}`, source: n.id, target: n.loop.target,
        label: `↻ max=${n.loop.max}`, animated: true,
        style: { stroke: '#d29922', strokeDasharray: '6 4' },
        labelStyle: { fill: '#d29922' }, labelBgStyle: { fill: '#161b22' },
      })),
    ],
    [graph, statuses]
  )
  const handleDragStop = useCallback((_, node) => onMove(node.id, [Math.round(node.position.x), Math.round(node.position.y)]), [onMove])
  const handleConnect = useCallback((c) => c.source !== c.target && onConnect(c.source, c.target), [onConnect])

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onNodeDragStop={handleDragStop} onConnect={handleConnect}
      fitView colorMode="dark" proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} color="#21262d" />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
