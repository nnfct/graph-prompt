---
title: 스모크 테스트
layout:
  a: [80, 40]
  b: [80, 220]
  merge: [400, 130]
---

## a `claude`
next: merge
prompt: |
  단어 "빨강" 하나만 반환한다.
out: {word: str}

## b `claude`
next: merge
prompt: |
  단어 "파랑" 하나만 반환한다.
out: {word: str}

## merge `claude`
prompt: |
  입력으로 받은 두 단어를 합쳐 한 문장으로 만든다.
out: {sentence: str}
