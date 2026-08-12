// 로컬 전용 서버. 의존성 0 (node:http). 외부 노출 금지 — 127.0.0.1 바인딩.
// 실행은 run-child.mjs 자식 프로세스: 취소=kill, 서버 크래시와 격리.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { parseGraph, serializeGraph, topoCheck } from './parse.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const GRAPHS = join(ROOT, 'graphs');
const RUNS = join(ROOT, 'runs');
const LIVE = join(RUNS, '.live');
const DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.PORT || 4680);

const ISOLATE = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json' };

// runId → { events: [], clients: Set, status, child, name }
const live = new Map();

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((ok, no) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 20e6) { no(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
  });

const safeName = (s) => /^[\w가-힣.-]+$/.test(s || '');

function broadcast(run, rec) {
  run.events.push(rec);
  const line = `data: ${JSON.stringify(rec)}\n\n`;
  for (const c of run.clients) c.write(line);
}

async function startRun(md, name) {
  const g = parseGraph(md);
  if (g.errors.length) return { errors: g.errors };
  if (!topoCheck(g).ok) return { errors: ['사이클 존재 — 되돌림은 loop: 로만 표현한다.'] };

  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await mkdir(LIVE, { recursive: true });
  const mdFile = join(LIVE, `${name}--${runId}.md`);
  await writeFile(mdFile, md);

  // detached → 자식이 새 프로세스 그룹장이 되고, 취소 시 그룹째 kill 해서
  // 노드로 spawn 된 claude/codex 까지 함께 정리된다 (고아 방지)
  const child = spawn(process.execPath, [join(ROOT, 'server', 'run-child.mjs'), mdFile, runId, name], {
    cwd: ROOT, detached: true,
  });
  const run = { events: [], clients: new Set(), status: 'running', child, name, runId, startedAt: Date.now() };
  live.set(runId, run);

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { broadcast(run, JSON.parse(line)); } catch { /* 비정형 라인 무시 */ }
    }
  });
  child.stderr.on('data', (d) => broadcast(run, { kind: 'stderr', text: String(d).slice(0, 2000) }));
  child.on('close', (code) => {
    run.status = code === 0 ? 'done' : run.status === 'canceled' ? 'canceled' : 'failed';
    broadcast(run, { kind: 'child:exit', code, status: run.status });
    for (const c of run.clients) c.end();
    run.clients.clear();
  });
  return { runId };
}

// 자연어 → 그래프 MD (draft / patch). 파싱 검증 후 반환, 실패 시 에러와 원문.
async function aiDraft(instruction, currentMd) {
  const spec = `그래프 MD 스펙:
- frontmatter 에 title, layout(노드별 [x,y])
- "## 노드id \`타입\`" 헤딩 하나 = 노드 하나. 타입: claude | codex | research | red-team
- 속성: prompt(멀티라인은 "prompt: |" 뒤 2칸 들여쓰기), out(출력 JSON 스키마), next(쉼표=병렬 분기), in(생략시 next에서 역산), lens(쉼표 구분 — 렌즈별 동시 실행), model(선택), loop
- loop 문법: "loop: until(조건, max=N) -> 대상노드" 또는 "loop: max=N -> 대상노드". 조건은 숫자비교식(coverage>=0.9) 또는 자연어(AI가 판정)
- 병렬 갈래는 next 를 여러 노드로. 합류는 그 노드들의 next 를 같은 노드로.
- research 노드만 웹검색 가능. red-team 은 lens 3개(출처신뢰도, 결론반증, 놓친관점)가 관례.
- 해석 불가 라인은 에러다. 스펙 밖 문법 금지. 주석 금지.`;
  const prompt = currentMd
    ? `${spec}\n\n# 현재 그래프\n${currentMd}\n\n# 지시\n${instruction}\n\n# 출력 규칙\n수정된 그래프 MD 전문만 출력한다. 코드펜스·해설 금지. frontmatter(---)부터 시작한다.`
    : `${spec}\n\n# 지시\n다음 작업을 수행하는 그래프를 설계한다: ${instruction}\n\n노드 4~9개. 병렬 갈래와 검증(red-team) 단계를 적극 사용한다.\n\n# 출력 규칙\n그래프 MD 전문만 출력한다. 코드펜스·해설 금지. frontmatter(---)부터 시작한다.`;

  const r = await new Promise((ok) => {
    const p = spawn('claude', ['-p', '--output-format', 'json', '--model', 'sonnet', '--tools', 'none', ...ISOLATE]);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => ok({ out, err }));
    p.stdin.write(prompt); p.stdin.end();
  });
  let text = '';
  try { text = JSON.parse(r.out).result || ''; } catch { return { error: 'claude 호출 실패: ' + r.err.slice(0, 300) }; }
  text = text.replace(/^```(?:markdown|md)?\n?/, '').replace(/\n?```\s*$/, '').trim() + '\n';
  const g = parseGraph(text);
  // 좌표 없는 노드에 자동 배치 (draft 는 layout 을 자주 빠뜨린다)
  if (!g.errors.length) {
    let y = 40;
    for (const n of g.nodes) if (!n.pos) { n.pos = [Math.min(200 + n.in.length * 260, 1200), y]; y += 140; }
    text = serializeGraph(g);
  }
  return { md: text, errors: g.errors };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/graphs' && req.method === 'GET') {
      const files = (await readdir(GRAPHS)).filter((f) => f.endsWith('.md'));
      return json(res, 200, files);
    }
    if (p === '/api/graph' && req.method === 'GET') {
      const f = url.searchParams.get('file');
      if (!safeName(f)) return json(res, 400, { error: 'bad name' });
      return json(res, 200, { md: await readFile(join(GRAPHS, f), 'utf8') });
    }
    if (p === '/api/graph' && req.method === 'PUT') {
      const { file, md } = await readBody(req);
      if (!safeName(file)) return json(res, 400, { error: 'bad name' });
      await writeFile(join(GRAPHS, file), md);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/validate' && req.method === 'POST') {
      const { md } = await readBody(req);
      const g = parseGraph(md);
      return json(res, 200, { errors: g.errors, nodes: g.nodes.length });
    }
    if (p === '/api/run' && req.method === 'POST') {
      const { md, name } = await readBody(req);
      if (!safeName(name)) return json(res, 400, { error: 'bad name' });
      const r = await startRun(md, name);
      return json(res, r.errors ? 422 : 200, r);
    }
    if (p === '/api/cancel' && req.method === 'POST') {
      const { runId } = await readBody(req);
      const run = live.get(runId);
      if (!run) return json(res, 404, { error: 'no such run' });
      run.status = 'canceled';
      try { process.kill(-run.child.pid, 'SIGTERM'); } catch { run.child.kill('SIGTERM'); }
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/stream/') && req.method === 'GET') {
      const run = live.get(p.split('/').pop());
      if (!run) return json(res, 404, { error: 'no such live run' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const rec of run.events) res.write(`data: ${JSON.stringify(rec)}\n\n`); // 늦게 붙어도 처음부터 재생
      if (run.status !== 'running') return res.end();
      run.clients.add(res);
      req.on('close', () => run.clients.delete(res));
      return;
    }
    if (p === '/api/runs' && req.method === 'GET') {
      const out = [];
      for (const f of (await readdir(RUNS)).filter((f) => f.endsWith('.json'))) {
        const st = await stat(join(RUNS, f));
        out.push({ file: f, size: st.size, mtime: st.mtimeMs });
      }
      out.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { finished: out, live: [...live.values()].filter((r) => r.status === 'running').map((r) => ({ runId: r.runId, name: r.name, startedAt: r.startedAt })) });
    }
    if (p === '/api/run-file' && req.method === 'GET') {
      const f = url.searchParams.get('file');
      if (!safeName(f)) return json(res, 400, { error: 'bad name' });
      res.writeHead(200, { 'content-type': 'application/json' });
      return createReadStream(join(RUNS, f)).pipe(res);
    }
    if (p === '/api/draft' && req.method === 'POST') {
      const { instruction, md } = await readBody(req);
      return json(res, 200, await aiDraft(instruction, md || ''));
    }

    // 정적 파일 (web/dist)
    let file = join(DIST, p === '/' ? 'index.html' : p.slice(1));
    if (!file.startsWith(DIST) || !existsSync(file)) file = join(DIST, 'index.html');
    if (!existsSync(file)) return json(res, 404, { error: 'web/dist 없음 — cd web && npm run build' });
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    return createReadStream(file).pipe(res);
  } catch (e) {
    return json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`graph-prompt: http://localhost:${PORT} (로컬 전용)`);
});
