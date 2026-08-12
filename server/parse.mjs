// 그래프가 정본, MD는 직렬화 산출물.
// 라운드트립 무손실이 요구사항이라 알 수 없는 키도 원문 순서대로 보존한다.

const NODE_RE = /^##\s+([A-Za-z0-9._-]+)\s+`([a-z-]+)`\s*$/;
const KV_RE = /^([a-z_]+):[ \t]*(.*)$/;
const LOOP_RE =
  /^(?:until\((.+?)(?:,\s*max\s*=\s*(\d+))?\)|max\s*=\s*(\d+))\s*->\s*([A-Za-z0-9._-]+)$/;

export const NODE_TYPES = ['claude', 'codex', 'research', 'red-team'];

function splitFrontmatter(md) {
  md = md.replace(/\r\n/g, '\n');
  if (!md.startsWith('---\n')) return { fm: '', body: md };
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: '', body: md };
  return { fm: m[1], body: md.slice(m[0].length).replace(/^\n/, '') };
}

function parseFrontmatter(fm) {
  const out = { title: '', layout: {} };
  let inLayout = false;
  for (const line of fm.split('\n')) {
    if (/^layout:\s*$/.test(line)) { inLayout = true; continue; }
    if (inLayout && /^\s+/.test(line)) {
      const m = line.match(/^\s+([A-Za-z0-9._-]+):\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/);
      if (m) out.layout[m[1]] = [Number(m[2]), Number(m[3])];
      continue;
    }
    inLayout = false;
    const t = line.match(/^title:\s*(.*)$/);
    if (t) out.title = t[1].trim();
  }
  return out;
}

function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseLoop(v) {
  const m = String(v).trim().match(LOOP_RE);
  if (!m) return null;
  const [, cond, condMax, plainMax, target] = m;
  return {
    // 종료조건 3종: 횟수(max) / 조건식(expr) / AI판단(ask)
    max: Number(condMax || plainMax || 3),
    cond: cond ? cond.trim() : null,
    kind: !cond ? 'count' : /[<>=]=?/.test(cond) ? 'expr' : 'ask',
    target,
  };
}

export function parseGraph(md) {
  const { fm, body } = splitFrontmatter(md);
  const head = parseFrontmatter(fm);
  const nodes = [];
  const errors = [];

  let cur = null;
  let blockKey = null;
  let blockBuf = null;

  const flushBlock = () => {
    if (cur && blockKey !== null) {
      cur.attrs.push({ k: blockKey, v: blockBuf.join('\n').replace(/\s+$/, ''), block: true });
    }
    blockKey = null;
    blockBuf = null;
  };

  const lines = body.split('\n');
  lines.forEach((line, i) => {
    const nm = line.match(NODE_RE);
    if (nm) {
      flushBlock();
      cur = { id: nm[1], type: nm[2], attrs: [] };
      if (!NODE_TYPES.includes(cur.type)) errors.push(`${cur.id}: 알 수 없는 노드 타입 \`${cur.type}\``);
      if (nodes.some((n) => n.id === cur.id)) errors.push(`${cur.id}: 중복된 노드 id`);
      nodes.push(cur);
      return;
    }

    if (cur && blockKey !== null) {
      if (line.startsWith('  ') || line.trim() === '') {
        blockBuf.push(line.replace(/^ {2}/, ''));
        return;
      }
      flushBlock();
    }

    if (line.trim() === '') return;

    const kv = cur && line.match(KV_RE);
    if (kv) {
      if (kv[2].trim() === '|') { blockKey = kv[1]; blockBuf = []; }
      else cur.attrs.push({ k: kv[1], v: kv[2].trim(), block: false });
      return;
    }

    // 무손실 선언: 해석 불가 라인은 무음 증발 대신 에러. 실행 차단 대상.
    errors.push(`${cur ? cur.id + ' 노드 ' : ''}${i + 1}행: 해석 불가 라인 — "${line.trim().slice(0, 60)}"`);
  });
  flushBlock();

  // 구조 파생
  for (const n of nodes) {
    const get = (k) => n.attrs.find((a) => a.k === k)?.v;
    n.prompt = get('prompt') || '';
    n.out = get('out') || '';
    n.lens = list(get('lens'));
    n.next = list(get('next'));
    n.inExplicit = list(get('in'));
    n.loop = get('loop') ? parseLoop(get('loop')) : null;
    if (get('loop') && !n.loop) errors.push(`${n.id}: loop 문법 오류 — "${get('loop')}"`);
    n.pos = head.layout[n.id] || null;
  }

  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    for (const t of n.next) if (!ids.has(t)) errors.push(`${n.id}: next 대상 없음 → ${t}`);
    for (const t of n.inExplicit) if (!ids.has(t)) errors.push(`${n.id}: in 대상 없음 → ${t}`);
    if (n.loop && !ids.has(n.loop.target)) errors.push(`${n.id}: loop 대상 없음 → ${n.loop.target}`);
  }

  // in 자동 역산 (명시된 게 있으면 그것을 쓴다)
  for (const n of nodes) {
    n.in = n.inExplicit.length
      ? n.inExplicit
      : nodes.filter((m) => m.next.includes(n.id)).map((m) => m.id);
  }

  const edges = [];
  for (const n of nodes) for (const t of n.next) if (ids.has(t)) edges.push({ from: n.id, to: t });

  return { title: head.title, nodes, edges, errors };
}

export function serializeGraph(g) {
  const layout = g.nodes.filter((n) => n.pos);
  let out = '---\n';
  if (g.title) out += `title: ${g.title}\n`;
  if (layout.length) {
    out += 'layout:\n';
    for (const n of layout) out += `  ${n.id}: [${n.pos[0]}, ${n.pos[1]}]\n`;
  }
  out += '---\n\n';
  for (const n of g.nodes) {
    out += `## ${n.id} \`${n.type}\`\n`;
    for (const a of n.attrs) {
      if (a.block) {
        out += `${a.k}: |\n`;
        out += a.v.split('\n').map((l) => (l.trim() ? `  ${l}` : '')).join('\n') + '\n';
      } else {
        out += `${a.k}: ${a.v}\n`;
      }
    }
    out += '\n';
  }
  return out.replace(/\n+$/, '\n');
}

// 계층 자동 배치: rank(루트로부터 최장 경로) = 열, 열 안에서 세로 나열.
// 좌→우 흐름이 강제되어 smoothstep 엣지가 직선/직각으로 떨어진다.
export function autoLayout(g) {
  const rank = new Map(g.nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < g.nodes.length; i++)
    for (const e of g.edges)
      rank.set(e.to, Math.max(rank.get(e.to) ?? 0, (rank.get(e.from) ?? 0) + 1));
  const cols = new Map();
  for (const n of g.nodes) {
    const r = rank.get(n.id) ?? 0;
    if (!cols.has(r)) cols.set(r, []);
    cols.get(r).push(n);
  }
  const X = 320, Y = 190;
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length));
  for (const [r, list] of cols) {
    const offset = ((maxRows - list.length) * Y) / 2;
    list.forEach((n, i) => { n.pos = [40 + r * X, 40 + Math.round(offset + i * Y)]; });
  }
  return g;
}

// 실행 순서 검증. 루프 엣지는 되돌림이므로 사이클 판정에서 제외한다.
export function topoCheck(g) {
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) indeg.set(e.to, indeg.get(e.to) + 1);
  const q = g.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const e of g.edges.filter((e) => e.from === id)) {
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) q.push(e.to);
    }
  }
  return { ok: order.length === g.nodes.length, order };
}

// 재실행 대상 = target→루프노드 "경로 위" 노드만.
// target에서 도달 가능한 전체를 잡으면 곁가지(실행 중일 수 있음)까지 리셋해
// 이중 spawn·트레이스 유실이 난다. (Fable H1)
export function loopScope(g, node) {
  const fwd = new Set();
  const walk = (id) => {
    if (fwd.has(id) || id === undefined) return;
    fwd.add(id);
    for (const e of g.edges.filter((e) => e.from === id)) walk(e.to);
  };
  walk(node.loop.target);
  // fwd 안에서 루프 노드의 조상만 남긴다 (루프 노드 포함)
  const scope = new Set([node.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of g.edges) {
      if (fwd.has(e.from) && scope.has(e.to) && !scope.has(e.from)) {
        scope.add(e.from);
        grew = true;
      }
    }
  }
  return scope;
}
