// 서버가 spawn 하는 실행 자식. 이벤트를 stdout JSONL 로 흘리고,
// 트레이스를 runs/ 에 저장한다. 취소 = 이 프로세스 kill (SIGTERM 전파).
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseGraph } from './parse.mjs';
import { runGraph, saveRun, makeAppender } from './run.mjs';

const [mdFile, runId, graphName] = process.argv.slice(2);
const md = await readFile(resolve(mdFile), 'utf8');
const g = parseGraph(md);
if (g.errors.length) {
  process.stdout.write(JSON.stringify({ kind: 'fatal', errors: g.errors }) + '\n');
  process.exit(1);
}

const runsDir = resolve(import.meta.dirname, '../runs');
const appender = makeAppender(runsDir, graphName, runId);
const out = (rec) => process.stdout.write(JSON.stringify(rec) + '\n');

// SIGTERM 시 자식 claude/codex 프로세스도 함께 죽도록 프로세스 그룹째 종료
process.on('SIGTERM', () => process.exit(143));

const res = await runGraph(g, {
  runId,
  appendEvent: (rec) => { appender.append(rec); out(rec); },
  emit: (e) => { if (e.type === 'node:start' || e.type === 'node:skipped' || e.type === 'loop' || e.type === 'run:start') out({ kind: 'live', ...e }); },
});

await appender.flush();
const f = await saveRun(runsDir, graphName, res, md);
out({ kind: 'saved', file: f });
