// README/마케팅에 쓰는 수치의 재현 스크립트. n>=3, 결과는 JSON 아티팩트로 저장.
// 실행: node benchmarks/measure.mjs  (구독 CLI 로그인 필요, 환산 비용 ~$1.5)
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';

const N = 3;
const ISOLATE = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''];

function callJson(args, stdin) {
  return new Promise((ok) => {
    const t0 = Date.now();
    const p = spawn('claude', args);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      let meta = null;
      try { meta = JSON.parse(out); } catch { /* noop */ }
      ok({ ms: Date.now() - t0, meta });
    });
    p.stdin.write(stdin); p.stdin.end();
  });
}

function firstDelta(args, stdin) {
  return new Promise((ok) => {
    const t0 = Date.now();
    const p = spawn('claude', args);
    let buf = '', first = null;
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (first == null && ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta') first = Date.now() - t0;
        } catch { /* noop */ }
      }
    });
    p.on('close', () => ok({ firstDeltaMs: first, totalMs: Date.now() - t0 }));
    p.stdin.write(stdin); p.stdin.end();
  });
}

const ctx = (m) => ({
  fixedContext: (m.meta?.usage?.cache_creation_input_tokens ?? 0) + (m.meta?.usage?.cache_read_input_tokens ?? 0),
  cost: m.meta?.total_cost_usd ?? null,
});

console.error('1/3 격리 호출 ×' + N);
const isolated = [];
for (let i = 0; i < N; i++) isolated.push(ctx(await callJson(['-p', '--output-format', 'json', '--model', 'sonnet', '--tools', 'none', ...ISOLATE], 'PONG 한 단어만.')));

console.error('2/3 비격리 호출 ×' + N + ' (개인 설정·MCP 로드됨)');
const plain = [];
for (let i = 0; i < N; i++) plain.push(ctx(await callJson(['-p', '--output-format', 'json', '--model', 'sonnet', '--tools', 'none'], 'PONG 한 단어만.')));

console.error('3/3 draft 첫 델타 ×' + N);
const draftPrompt = '그래프 MD 스펙: "## id `타입`" 헤딩=노드, prompt/next/out 속성.\n\n# 지시\n리서치 2갈래 → 종합 그래프를 설계한다.\n\n# 출력 규칙\n그래프 MD 전문만.';
const drafts = [];
for (let i = 0; i < N; i++) drafts.push(await firstDelta(['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--model', 'sonnet', '--effort', 'low', '--tools', 'none', '--system-prompt', '그래프 MD 생성기. 요청 형식만 출력.', ...ISOLATE], draftPrompt));

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const result = {
  date: new Date().toISOString().slice(0, 10),
  n: N,
  cliVersion: null,
  note: '고정 컨텍스트 = cache_creation + cache_read. 비격리는 세션 디렉토리·설치 플러그인에 따라 변동.',
  isolatedContextTok: { runs: isolated.map((x) => x.fixedContext), median: med(isolated.map((x) => x.fixedContext)) },
  plainContextTok: { runs: plain.map((x) => x.fixedContext), median: med(plain.map((x) => x.fixedContext)) },
  isolatedCostUsd: { runs: isolated.map((x) => x.cost), median: med(isolated.map((x) => x.cost)) },
  plainCostUsd: { runs: plain.map((x) => x.cost), median: med(plain.map((x) => x.cost)) },
  draftFirstDeltaMs: { runs: drafts.map((x) => x.firstDeltaMs), median: med(drafts.map((x) => x.firstDeltaMs)) },
  draftTotalMs: { runs: drafts.map((x) => x.totalMs), median: med(drafts.map((x) => x.totalMs)) },
};

const v = await new Promise((ok) => {
  const p = spawn('claude', ['--version']);
  let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('close', () => ok(o.trim()));
});
result.cliVersion = v;

await mkdir(new URL('.', import.meta.url).pathname, { recursive: true });
const f = new URL(`./${result.date}-bench.json`, import.meta.url).pathname;
await writeFile(f, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.error('저장: ' + f);
