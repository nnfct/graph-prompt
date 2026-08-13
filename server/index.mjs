// 로컬 전용 서버. 의존성 0 (node:http). 외부 노출 금지 — 127.0.0.1 바인딩.
// 실행은 run-child.mjs 자식 프로세스: 취소=kill, 서버 크래시와 격리.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, stat, mkdir, unlink } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { parseGraph, serializeGraph, topoCheck, autoLayout } from './parse.mjs';
import { checkCli, reportCli } from './cli-check.mjs';
import { newRunId } from './run.mjs';

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

  const runId = newRunId();
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
  child.on('error', (e) => broadcast(run, { kind: 'stderr', text: 'run-child 실행 불가: ' + String(e).slice(0, 300) }));
  child.stderr.on('data', (d) => broadcast(run, { kind: 'stderr', text: String(d).slice(0, 2000) }));
  child.on('close', (code) => {
    run.status = code === 0 ? 'done' : run.status === 'canceled' ? 'canceled' : 'failed';
    broadcast(run, { kind: 'child:exit', code, status: run.status });
    for (const c of run.clients) c.end();
    run.clients.clear();
    unlink(mdFile).catch(() => {}); // .live 임시 그래프 누적 방지 (원문은 saveRun 이 graphMd 로 동봉)
  });
  return { runId };
}

const SPEC = `그래프 MD 스펙:
- frontmatter 에 title, layout(노드별 [x,y])
- "## 노드id \`타입\`" 헤딩 하나 = 노드 하나. 타입: claude | codex | research | red-team
- 속성: prompt(멀티라인은 "prompt: |" 뒤 2칸 들여쓰기), out(출력 JSON 스키마), next(쉼표=병렬 분기), in(생략시 next에서 역산), lens(쉼표 구분 — 렌즈별 동시 실행), model(선택), loop
- loop 문법: "loop: until(조건, max=N) -> 대상노드" 또는 "loop: max=N -> 대상노드". 조건은 숫자비교식(coverage>=0.9) 또는 자연어(AI가 판정)
- 병렬 갈래는 next 를 여러 노드로. 합류는 그 노드들의 next 를 같은 노드로.
- research 노드만 웹검색 가능. red-team 은 lens 3개(출처신뢰도, 결론반증, 놓친관점)가 관례.
- 해석 불가 라인은 에러다. 스펙 밖 문법 금지. 주석 금지.\n- title 과 각 노드의 prompt 는 사용자 지시와 같은 언어로 쓴다 (영어 지시 → 영어 프롬프트).`;

function draftPrompt(instruction, currentMd) {
  return currentMd
    ? `${SPEC}\n\n# 현재 그래프\n${currentMd}\n\n# 지시\n${instruction}\n\n# 출력 규칙\n수정된 그래프 MD 전문만 출력한다. 코드펜스·해설 금지. frontmatter(---)부터 시작한다.`
    : `${SPEC}\n\n# 지시\n다음 작업을 수행하는 그래프를 설계한다: ${instruction}\n\n노드 4~9개. 병렬 갈래와 검증(red-team) 단계를 적극 사용한다.\n\n# 출력 규칙\n그래프 MD 전문만 출력한다. 코드펜스·해설 금지. frontmatter(---)부터 시작한다.`;
}

// 자연어 → 그래프 MD (draft / patch). 파싱 검증 후 반환, 실패 시 에러와 원문.
async function aiDraft(instruction, currentMd) {
  const prompt = draftPrompt(instruction, currentMd);

  const r = await new Promise((ok) => {
    const p = spawn('claude', ['-p', '--output-format', 'json', '--model', 'sonnet', '--tools', 'none', ...ISOLATE]);
    let out = '', err = '';
    p.on('error', (e) => ok({ out: '', err: String(e) })); // ENOENT 등 — 서버 크래시 방지
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => ok({ out, err }));
    p.stdin.write(prompt); p.stdin.end();
  });
  let text = '';
  try { text = JSON.parse(r.out).result || ''; } catch { return { error: 'claude 호출 실패: ' + r.err.slice(0, 300) }; }
  return finalizeDraft(text);
}

// 최신 run 트레이스에서 노드별 실측 요약을 뽑는다 (최적화 프롬프트 재료)
async function runStats(name) {
  const files = (await readdir(RUNS).catch(() => []))
    .filter((f) => f.startsWith(name + '--') && f.endsWith('.json'))
    .sort();
  if (!files.length) return null;
  const d = JSON.parse(await readFile(join(RUNS, files[files.length - 1]), 'utf8'));
  const by = new Map();
  for (const t of d.trace || []) {
    if (t.kind === 'loop' || t.type === 'loop' || t.skipped) continue;
    const r = by.get(t.node) || { ms: 0, cost: 0, out: 0, iters: 0 };
    r.ms += t.ms || 0; r.cost += t.cost || 0; r.out += t.tokens?.out || 0; r.iters += 1;
    by.set(t.node, r);
  }
  const loops = (d.trace || []).filter((t) => t.kind === 'loop' || t.type === 'loop');
  return {
    file: files[files.length - 1],
    totalMin: (d.summary.ms / 60000).toFixed(1),
    lines: [...by.entries()].map(([n, r]) =>
      `${n}: ${r.iters}회 · ${(r.ms / 1000).toFixed(0)}s · $${r.cost.toFixed(2)} · 출력 ${r.out.toLocaleString()}tok`),
    loops: loops.map((l) => `${l.node} iter${l.iter}: ${l.repeat ? '재실행' : '종료'} — ${l.why}`),
  };
}

async function optimizePrompt(instruction, md, name) {
  const stats = name ? await runStats(name) : null;
  const statsText = stats
    ? `# 최신 실행 실측 (${stats.file}, 전체 ${stats.totalMin}분)\n${stats.lines.join('\n')}\n루프 판정:\n${stats.loops.join('\n') || '(없음)'}`
    : '# 실행 이력 없음 — 구조 원칙만으로 최적화한다';
  const hasGraph = md && md.trim().length > 0;
  const prompt = `너는 그래프 엔지니어링 최적화기다. 사용자의 할 일에 최적인 그래프를 설계한다.

${SPEC}

${instruction ? `# 사용자의 할 일 / 요구 (최우선)\n${instruction}\n` : ''}
${statsText}

${hasGraph ? `# 현재 그래프\n${md}\n\n할 일이 현재 그래프와 같은 작업이면 실측에 근거해 재설계하고, 다른 새 작업이면 현재 그래프는 참고만 하고 할 일에 맞는 그래프를 처음부터 최적으로 설계한다.` : '# 현재 그래프 없음 — 할 일에 맞는 그래프를 처음부터 최적으로 설계한다.'}

# 최적화 원칙 (실측에 근거해서만 적용)
- 직렬 체인 중 서로 독립인 노드는 병렬로 쪼갠다
- 출력 토큰이 큰 노드는 out 스키마를 좁혀라 — 출력 길이가 곧 지연이다
- 가벼운 판정·분류 노드는 model: haiku, 무거운 종합만 opus
- 루프 되돌림 지점은 최소 범위로 (웹검색 재실행 금지)
- 노드 수를 늘리는 게 아니라 wall-clock 을 줄이는 게 목적. 병렬화 이득이 없으면 합쳐라
- 그래프 MD 스펙을 정확히 지킨다 (해석 불가 라인은 에러다)

# 출력 형식 (정확히 이 형식)
근거를 5줄 이내로 쓴 뒤, 구분선 =====GRAPH===== 다음 줄부터 그래프 MD 전문만 출력한다. 코드펜스 금지.`;
  return prompt;
}

function finalizeOptimize(text) {
  const cut = text.indexOf('=====GRAPH=====');
  if (cut === -1) return { error: '형식 불일치 — 재시도 필요', raw: text.slice(0, 500) };
  const rationale = text.slice(0, cut).trim();
  let gmd = text.slice(cut + 15).replace(/^```(?:markdown|md)?\n?/m, '').replace(/\n?```\s*$/, '').trim() + '\n';
  const g = parseGraph(gmd);
  if (!g.errors.length) gmd = serializeGraph(autoLayout(g));
  return { md: gmd, rationale, errors: g.errors };
}

function finalizeDraft(text) {
  let gmd = text.replace(/^```(?:markdown|md)?\n?/, '').replace(/\n?```\s*$/, '').trim() + '\n';
  const g = parseGraph(gmd);
  if (!g.errors.length) gmd = serializeGraph(autoLayout(g));
  return { md: gmd, errors: g.errors };
}

// 할 일 + 현재 그래프 + 실측 → 최적화된 그래프 제안 (비스트리밍 경로)
async function aiOptimize(instruction, md, name) {
  const prompt = await optimizePrompt(instruction, md, name);
  const r = await new Promise((ok) => {
    const p = spawn('claude', ['-p', '--output-format', 'json', '--model', 'sonnet', '--tools', 'none', ...ISOLATE]);
    let out = '', err = '';
    p.on('error', (e) => ok({ out: '', err: String(e) })); // ENOENT 등 — 서버 크래시 방지
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => ok({ out, err }));
    p.stdin.write(prompt); p.stdin.end();
  });
  let text = '';
  try { text = JSON.parse(r.out).result || ''; } catch { return { error: 'claude 호출 실패: ' + r.err.slice(0, 300) }; }
  return finalizeOptimize(text);
}

// 스트리밍: 생성 중 텍스트 델타를 그대로 흘린다 — "프롬프트 체감"의 핵심.
// 응답: text/event-stream. {t: "델타"} ... 마지막에 {done: true, ...finalize 결과}
const GEN_SYSTEM = '너는 그래프 MD 생성기다. 도구는 없다. 파일 탐색·확인 발언 금지. 요청된 출력 형식의 텍스트만 낸다.';

// 스트림 불가 환경(구/신 CLI 계약 변화) 폴백: 통짜 JSON 으로 받고 한 번에 흘린다.
function genFallback(prompt, send, finalize, res) {
  if (res.destroyed || res.writableEnded) return;
  const p = spawn('claude', ['-p', '--output-format', 'json', '--model', 'sonnet', '--tools', 'none', '--system-prompt', GEN_SYSTEM, ...ISOLATE]);
  let out = '', err = '', finished = false;
  const finish = (obj) => {
    if (finished || res.destroyed || res.writableEnded) return;
    finished = true;
    send(obj);
    res.end();
  };
  p.on('error', (e) => finish({ done: true, error: 'claude 실행 불가: ' + String(e).slice(0, 200) }));
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('close', () => {
    let text = '';
    try { text = JSON.parse(out).result || ''; } catch { /* 아래에서 처리 */ }
    if (!text) finish({ done: true, error: 'claude 호출 실패(폴백 포함): ' + err.slice(0, 300) });
    else { send({ t: text }); finish({ done: true, ...finalize(text) }); }
  });
  res.on('close', () => p.kill('SIGTERM'));
  p.stdin.write(prompt); p.stdin.end();
}

function streamClaude(res, prompt, finalize) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (obj) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const cli = checkCli();
  // 필수 계약이 깨졌으면 폴백도 같은 플래그로 실패한다 — 즉시 에러로 끝낸다
  if (!cli.version || cli.missing.length) {
    send({ done: true, error: 'claude CLI 계약 불일치: ' + (cli.missing.join(', ') || 'CLI 미검출') + ' — /api/health 확인' });
    return res.end();
  }
  const canStream = !cli.degraded.some((d) => d.includes('--include-partial-messages'));
  if (!canStream) return genFallback(prompt, send, finalize, res);

  // effort low: 생성 형식이 고정된 작업이라 thinking 최소화 → 첫 델타 지연 단축.
  // system prompt 고정: 도구 흉내·리포 탐색 서사 차단.
  const hasEffort = !cli.degraded.some((d) => d.includes('--effort'));
  const args = [
    '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--model', 'sonnet', ...(hasEffort ? ['--effort', 'low'] : []),
    '--tools', 'none', '--system-prompt', GEN_SYSTEM, ...ISOLATE,
  ];
  const p = spawn('claude', args);
  let buf = '', full = '', err = '', aborted = false;
  const eat = (line) => {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line);
      const delta = ev?.event?.delta;
      if (ev.type === 'stream_event' && delta?.type === 'text_delta' && delta.text) {
        full += delta.text;
        send({ t: delta.text });
      } else if (ev.type === 'system' && ev.subtype === 'thinking_tokens') {
        send({ think: ev.estimated_tokens }); // 생각 진행 신호 — 내용은 흘리지 않는다
      }
    } catch { /* 비 JSON 라인 무시 */ }
  };
  p.on('error', (e) => { send({ done: true, error: 'claude 실행 불가: ' + String(e).slice(0, 200) }); res.end(); });
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { eat(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => {
    eat(buf); // 마지막 줄 개행 누락 대비
    if (aborted || res.destroyed || res.writableEnded) return;
    // 델타를 한 글자도 못 얻었으면 (stream-json 계약 변화 등) 종료코드 무관 통짜 폴백 1회
    if (!full) return genFallback(prompt, send, finalize, res);
    send({ done: true, ...finalize(full) });
    res.end();
  });
  res.on('close', () => { aborted = true; p.kill('SIGTERM'); }); // 클라이언트 이탈 시 생성 중단, 폴백 금지
  p.stdin.write(prompt); p.stdin.end();
}

// CSRF/DNS-리바인딩 방어.
// - Origin 이 있으면(브라우저 요청) 우리 오리진만 허용 — 악성 페이지의
//   no-cors/text/plain 요청도 Origin 은 반드시 실어 보내므로 여기서 죽는다.
// - Host 는 항상 검증 — 공격자 도메인을 127.0.0.1 로 리졸브시키는
//   DNS 리바인딩은 Host 헤더가 공격자 도메인이라 걸린다.
// - Origin 없는 요청(curl 등 로컬 도구)은 허용.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
function originOk(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  const o = req.headers.origin;
  if (o == null) return true;
  try { return ALLOWED_HOSTS.has(new URL(o).host); } catch { return false; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p.startsWith('/api/') && !originOk(req)) {
    return json(res, 403, { error: 'origin/host 검증 실패 — 로컬 UI 또는 로컬 도구에서만 호출 가능' });
  }
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
    if (p === '/api/health' && req.method === 'GET') {
      return json(res, 200, checkCli());
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
    if (p === '/api/optimize' && req.method === 'POST') {
      const { instruction, md, name } = await readBody(req);
      return json(res, 200, await aiOptimize(instruction || '', md || '', safeName(name) ? name : null));
    }
    if (p === '/api/draft-stream' && req.method === 'POST') {
      const { instruction, md } = await readBody(req);
      return streamClaude(res, draftPrompt(instruction, md || ''), finalizeDraft);
    }
    if (p === '/api/optimize-stream' && req.method === 'POST') {
      const { instruction, md, name } = await readBody(req);
      return streamClaude(res, await optimizePrompt(instruction || '', md || '', safeName(name) ? name : null), finalizeOptimize);
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
  reportCli(); // CLI 계약 검증 — 플래그 소실을 기동 시점에 드러낸다
});
