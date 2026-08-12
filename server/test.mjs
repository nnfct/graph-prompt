// 네트워크 없이 도는 파서/구조 검증. 실행 전 반드시 통과해야 한다.
import { readFile } from 'node:fs/promises';
import { parseGraph, serializeGraph, topoCheck, loopScope } from './parse.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); }
};
const ok = (name, cond, info = '') => eq(name, !!cond, true) || (info && !cond && console.log('  ' + info));

const md = await readFile(new URL('../graphs/smoke.md', import.meta.url), 'utf8');
const g = parseGraph(md);

eq('노드 3개', g.nodes.length, 3);
eq('타입 파싱', g.nodes.map((n) => n.type), ['claude', 'claude', 'claude']);
eq('엣지', g.edges, [{ from: 'a', to: 'merge' }, { from: 'b', to: 'merge' }]);
eq('in 자동 역산', g.nodes.find((n) => n.id === 'merge').in, ['a', 'b']);
eq('좌표', g.nodes.find((n) => n.id === 'b').pos, [80, 220]);
eq('파싱 에러 없음', g.errors, []);
eq('멀티라인 prompt', g.nodes[0].prompt, '단어 "빨강" 하나만 반환한다.');
eq('위상정렬 통과', topoCheck(g).ok, true);

// 라운드트립 무손실 — 그래프가 정본이라는 전제가 여기서 깨지면 전부 무너진다
const again = parseGraph(serializeGraph(g));
eq('라운드트립: 노드', again.nodes.map((n) => [n.id, n.type, n.prompt, n.out, n.next, n.pos]),
   g.nodes.map((n) => [n.id, n.type, n.prompt, n.out, n.next, n.pos]));
eq('라운드트립: MD 안정', serializeGraph(again), serializeGraph(g));

// 루프 3종
const loopMd = `---
title: t
---

## seed \`claude\`
next: score
prompt: x

## score \`claude\`
loop: until(coverage>=0.9, max=3) -> seed
prompt: y

## solo \`claude\`
loop: max=2 -> solo
prompt: z

## ask \`claude\`
loop: until(충분히 검증되었는가, max=4) -> seed
prompt: w
`;
const lg = parseGraph(loopMd);
const score = lg.nodes.find((n) => n.id === 'score');
eq('루프 expr', [score.loop.kind, score.loop.cond, score.loop.max, score.loop.target],
   ['expr', 'coverage>=0.9', 3, 'seed']);
eq('루프 count', lg.nodes.find((n) => n.id === 'solo').loop.kind, 'count');
eq('루프 ask', lg.nodes.find((n) => n.id === 'ask').loop.kind, 'ask');
eq('loopScope', [...loopScope(lg, score)].sort(), ['score', 'seed']);

// 에러 검출
const bad = parseGraph('## x `wrong`\nnext: nope\nprompt: p\n');
ok('알 수 없는 타입 검출', bad.errors.some((e) => e.includes('노드 타입')));
ok('next 대상 없음 검출', bad.errors.some((e) => e.includes('next 대상 없음')));

// H2: 해석 불가 라인은 무음 증발 대신 에러
const typo = parseGraph('## x `claude`\nPrompt: 대문자 오타\nprompt: p\n');
ok('오타 라인 에러 검출 (H2)', typo.errors.some((e) => e.includes('해석 불가')));
const loose = parseGraph('떠도는 텍스트\n\n## x `claude`\nprompt: p\n');
ok('노드 밖 텍스트도 에러 (H2)', loose.errors.some((e) => e.includes('해석 불가')));

// M4: in 오타 검출
const badIn = parseGraph('## a `claude`\nprompt: p\nnext: b\n\n## b `claude`\nin: sedd\nprompt: q\n');
ok('in 대상 없음 검출 (M4)', badIn.errors.some((e) => e.includes('in 대상 없음')));

// H1: loopScope 가 곁가지를 포함하지 않는다
const sideMd = `## seed \`claude\`
prompt: x
next: synth, side

## side \`claude\`
prompt: 곁가지 - 루프 재실행 대상 아님
next: final

## synth \`claude\`
prompt: y
next: score

## score \`claude\`
prompt: z
next: final
loop: until(v>=1, max=2) -> synth

## final \`claude\`
in: side, score
prompt: f
`;
const sg = parseGraph(sideMd);
eq('파싱 에러 없음 (곁가지)', sg.errors, []);
eq('loopScope 곁가지 제외 (H1)', [...loopScope(sg, sg.nodes.find((n) => n.id === 'score'))].sort(),
   ['score', 'synth']);

// red-team lens
const rt = parseGraph('## r `red-team`\nlens: 출처신뢰도, 결론반증, 놓친관점\nprompt: p\n');
eq('lens 파싱', rt.nodes[0].lens, ['출처신뢰도', '결론반증', '놓친관점']);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
