// UI 없이 그래프를 돌려보는 경로. 서버·캔버스 없이도 실행+트레이스가 성립하는지 확인한다.
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseGraph, topoCheck } from './parse.mjs';
import { runGraph, saveRun, makeAppender, newRunId } from './run.mjs';
import { reportCli } from './cli-check.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node server/cli.mjs <graph.md>'); process.exit(1); }
if (!reportCli(console.error).ok) process.exit(1);

const md = await readFile(resolve(file), 'utf8');
const g = parseGraph(md);
if (g.errors.length) { console.error('그래프 오류:\n- ' + g.errors.join('\n- ')); process.exit(1); }
if (!topoCheck(g).ok) { console.error('그래프 오류: 사이클 존재 — 되돌림은 loop: 로만 표현한다.'); process.exit(1); }

const runId = newRunId();
const appender = makeAppender(resolve('runs'), basename(file, '.md'), runId);
const t0 = Date.now();
const el = () => `${String((Date.now() - t0) / 1000).padStart(6)}s`;

const res = await runGraph(g, {
  runId,
  appendEvent: appender.append,
  emit: (e) => {
    if (e.type === 'run:start') console.log(`${el()} ▶ 실행 시작 — 노드 ${e.nodes.length}개 · cwd ${e.cwd}`);
    else if (e.type === 'node:start') console.log(`${el()} ┌ ${e.node} [${e.nodeType}] 시작 (iter ${e.iter})`);
    else if (e.type === 'node:done')
      console.log(`${el()} └ ${e.node} ${e.ok ? '완료' : '실패'} · ${(e.ms / 1000).toFixed(1)}s · ${e.model || '-'} · $${(e.cost || 0).toFixed(4)}`);
    else if (e.type === 'loop') console.log(`${el()} ↻ ${e.node} 루프판정: ${e.repeat ? '재실행' : '종료'} — ${e.why}`);
    else if (e.type === 'node:skipped') console.log(`${el()} ⊘ ${e.node} 스킵 — 입력 전멸 [${e.missing.join(', ')}]`);
    else if (e.type === 'node:error') console.log(`${el()} ✕ ${e.node} stderr: ${(e.stderr || '').slice(0, 300)}`);
    else if (e.type === 'run:end')
      console.log(`${el()} ■ 종료 · $${e.cost.toFixed(4)} · out ${e.tokens.out} tok · 실패 [${e.failed.join(', ') || '없음'}] · 스킵 [${e.skipped.join(', ') || '없음'}]${e.stuck ? ` · 미실행 [${e.stuck.join(', ')}] ← 그래프 결함` : ''}`);
  },
});

await appender.flush();
const f = await saveRun(resolve('runs'), basename(file, '.md'), res, md);
console.log(`\n트레이스: ${f}`);
for (const t of res.trace.filter((t) => t.kind === 'node')) {
  const v = t.parsed ? JSON.stringify(t.parsed) : (t.raw || '').slice(0, 200);
  console.log(`  ${t.node}: ${v.slice(0, 300)}`);
}
