// 실제 claude/codex 대신 PATH의 로컬 mock을 spawn하는 실행기 통합 테스트.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGraph } from './parse.mjs';
import { runGraph } from './run.mjs';

const mockBin = fileURLToPath(new URL('./test-fixtures/mock-bin/', import.meta.url));
process.env.PATH = `${mockBin}:${process.env.PATH || ''}`;

let pass = 0, fail = 0;
const cleanupDirs = new Set();
const track = (result) => {
  cleanupDirs.add(result.summary.cwd);
  return result;
};
const run = async (md, options) => {
  const graph = parseGraph(md);
  assert.deepEqual(graph.errors, []);
  return track(await runGraph(graph, options));
};
const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail++;
    console.error(`FAIL ${name}\n  ${error.stack || error}`);
  }
};

try {
  await test('독립 노드 병렬 실행', async () => {
    const starts = [];
    const result = await run(`
## a \`claude\`
prompt: |
  MOCK_DELAY_MS:500
  MOCK_OUTPUT:{"branch":"a"}

## b \`claude\`
prompt: |
  MOCK_DELAY_MS:500
  MOCK_OUTPUT:{"branch":"b"}
`, { emit: (event) => {
      if (event.type === 'node:start') starts.push({ node: event.node, at: performance.now() });
    } });

    assert.equal(result.summary.failed.length, 0);
    assert.equal(starts.length, 2);
    assert.ok(Math.abs(starts[0].at - starts[1].at) < 100, '두 노드가 동시에 시작해야 한다');
    assert.ok(result.summary.ms < 900, `500ms 두 작업의 총 실행시간이 ${result.summary.ms}ms`);
  });

  await test('실패 갈래의 degraded 전파', async () => {
    const result = await run(`
## a \`claude\`
next: merge
prompt: MOCK_OUTPUT:{"branch":"a"}

## b \`claude\`
next: merge
prompt: MOCK_FAIL

## c \`claude\`
next: merge
prompt: MOCK_OUTPUT:{"branch":"c"}

## merge \`claude\`
prompt: MOCK_OUTPUT:{"merged":true}
`);
    const merge = result.trace.find((record) => record.kind === 'node' && record.node === 'merge');

    assert.deepEqual(result.summary.failed, ['b']);
    assert.deepEqual(result.summary.degraded, ['merge']);
    assert.equal(merge.ok, true);
    assert.deepEqual(merge.missingInputs, ['b']);
    assert.match(merge.promptSent, /## from: a\n[\s\S]*"branch": "a"/);
    assert.match(merge.promptSent, /## from: c\n[\s\S]*"branch": "c"/);
  });

  await test('입력 전멸 시 skip 연쇄', async () => {
    const result = await run(`
## root \`claude\`
next: middle
prompt: MOCK_FAIL

## middle \`claude\`
next: leaf
prompt: MOCK_OUTPUT:{"middle":true}

## leaf \`claude\`
prompt: MOCK_OUTPUT:{"leaf":true}
`);

    assert.deepEqual(result.summary.failed, ['root']);
    assert.deepEqual(result.summary.skipped, ['middle', 'leaf']);
    assert.equal(result.state.middle.status, 'skipped');
    assert.equal(result.state.leaf.status, 'skipped');
  });

  await test('루프 2회차에 이전 판정 피드백 주입', async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'gc-mock-log-'));
    const logFile = join(logDir, 'prompts.jsonl');
    cleanupDirs.add(logDir);
    process.env.MOCK_PROMPT_LOG = logFile;
    let result;
    try {
      result = await run(`
## a \`claude\`
loop: max=2 -> a
prompt: MOCK_OUTPUT:{"iteration":"ok"}
`);
    } finally {
      delete process.env.MOCK_PROMPT_LOG;
    }

    const calls = (await readFile(logFile, 'utf8')).split('\n__MOCK_PROMPT_END__\n').filter(Boolean);
    assert.equal(result.state.a.iter, 2);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[0], /# 이전 루프 판정/);
    assert.match(calls[1], /# 이전 루프 판정/);
  });

  await test('멀티 lens 실행별 prompt 보존', async () => {
    const result = await run(`
## review \`red-team\`
lens: 출처신뢰도, 결론반증
prompt: MOCK_OUTPUT:{"reviewed":true}
`);
    const record = result.trace.find((item) => item.kind === 'node' && item.node === 'review');

    assert.equal(record.lensRuns.length, 2);
    assert.deepEqual(record.lensRuns.map((item) => item.lens), ['출처신뢰도', '결론반증']);
    for (const lensRun of record.lensRuns) {
      assert.equal(typeof lensRun.prompt, 'string');
      assert.match(lensRun.prompt, new RegExp(`lens: ${lensRun.lens}`));
    }
    assert.notEqual(record.lensRuns[0].prompt, record.lensRuns[1].prompt);
  });

  await test('같은 밀리초 runId 유일성', async () => {
    const RealDate = globalThis.Date;
    const fixedMs = RealDate.now();
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fixedMs])); }
      static now() { return fixedMs; }
    };
    let results;
    try {
      const graph = parseGraph('');
      results = await Promise.all([runGraph(graph), runGraph(graph)]);
    } finally {
      globalThis.Date = RealDate;
    }
    const [first, second] = results.map(track);
    assert.notEqual(first.summary.runId, second.summary.runId);
  });

  await test('노드 트레이스 필드 무결성', async () => {
    const result = await run(`
## claude-node \`claude\`
prompt: MOCK_OUTPUT:{"engine":"claude"}

## codex-node \`codex\`
prompt: MOCK_OUTPUT:{"engine":"codex"}
`);
    const records = result.trace.filter((record) => record.kind === 'node');

    assert.equal(records.length, 2);
    for (const record of records) {
      for (const key of ['kind', 'promptSent', 'raw', 'tokens']) {
        assert.ok(Object.hasOwn(record, key), `${record.node} trace에 ${key}가 있어야 한다`);
      }
      assert.equal(typeof record.promptSent, 'string');
      assert.equal(typeof record.raw, 'string');
    }
    assert.deepEqual(records.find((record) => record.node === 'claude-node').tokens,
      { in: 11, out: 7, cacheWrite: 3, cacheRead: 2 });
    assert.equal(records.find((record) => record.node === 'codex-node').tokens, null);
  });
} finally {
  await Promise.all([...cleanupDirs].map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
