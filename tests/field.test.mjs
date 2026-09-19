/**
 * D4(재생성 시 사용자 수정 보존)가 실제로 지켜지는지 확인한다.
 * 여기가 깨지면 사용자가 고친 문구가 소리 없이 사라진다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { field, editByUser, mergeBundle, describeLocks } from '../src/core/field.mjs';

/** 카드 3장짜리 묶음. 사용자가 카드 2의 제목만 고친 상태. */
function makeBundle() {
  const card = (id, headline) => ({
    id,
    eyebrow: field(`태그 ${id}`),
    headline: field(headline),
    body: field(`본문 ${id}`),
    photo: field(`/gen/${id}.png`),
  });
  return {
    instagram: {
      cards: [card('c1', '원래 제목 1'), card('c2', '원래 제목 2'), card('c3', '원래 제목 3')],
      caption: field('원래 캡션'),
    },
  };
}

function incoming() {
  const card = (id) => ({
    id,
    eyebrow: field(`새 태그 ${id}`),
    headline: field(`새 제목 ${id}`),
    body: field(`새 본문 ${id}`),
    photo: field(`/gen/${id}-v2.png`),
  });
  return {
    instagram: {
      cards: [card('c1'), card('c2'), card('c3')],
      caption: field('새 캡션'),
    },
  };
}

test('사진만 다시 — 문구는 잠금 여부와 무관하게 전부 보존된다', () => {
  const cur = makeBundle();
  cur.instagram.cards[1].headline = editByUser(cur.instagram.cards[1].headline, '내가 고친 제목');

  const { merged, report } = mergeBundle(cur, incoming(), 'photo');
  const cards = merged.instagram.cards;

  // 잠긴 것도, 안 잠긴 것도 전부 유지
  assert.equal(cards[1].headline.value, '내가 고친 제목');
  assert.equal(cards[0].headline.value, '원래 제목 1');
  assert.equal(cards[0].body.value, '본문 c1');
  assert.equal(merged.instagram.caption.value, '원래 캡션');

  // 사진만 교체
  assert.equal(cards[0].photo.value, '/gen/c1-v2.png');
  assert.equal(cards[2].photo.value, '/gen/c3-v2.png');
  assert.ok(report.replaced.some((p) => p.endsWith('photo')));
  assert.equal(report.replaced.filter((p) => !p.endsWith('photo')).length, 0);
});

test('문구만 다시 — 잠긴 문구는 남고 안 잠긴 문구만 바뀐다', () => {
  const cur = makeBundle();
  cur.instagram.cards[1].headline = editByUser(cur.instagram.cards[1].headline, '내가 고친 제목');

  const { merged, report } = mergeBundle(cur, incoming(), 'text');
  const cards = merged.instagram.cards;

  assert.equal(cards[1].headline.value, '내가 고친 제목', '잠긴 제목이 덮어써졌다');
  assert.equal(cards[1].body.value, '새 본문 c2', '같은 카드의 안 잠긴 본문은 바뀌어야 한다');
  assert.equal(cards[0].headline.value, '새 제목 c1');
  assert.equal(merged.instagram.caption.value, '새 캡션');

  // 사진은 손대지 않는다
  assert.equal(cards[0].photo.value, '/gen/c1.png');
  assert.equal(cards[1].photo.value, '/gen/c2.png');

  assert.ok(report.kept.includes('instagram.cards.c2.headline'));
});

test('카드 순서가 바뀌어도 사용자 수정이 엉뚱한 카드에 붙지 않는다', () => {
  const cur = makeBundle();
  cur.instagram.cards[1].headline = editByUser(cur.instagram.cards[1].headline, '내가 고친 제목');

  // 새 결과에서 카드 순서를 뒤집는다
  const inc = incoming();
  inc.instagram.cards.reverse();

  const { merged } = mergeBundle(cur, inc, 'text');
  const c2 = merged.instagram.cards.find((c) => c.id === 'c2');
  assert.equal(c2.headline.value, '내가 고친 제목');
});

test('전체 재생성은 잠긴 것까지 덮어쓰되 무엇을 잃는지 보고한다', () => {
  const cur = makeBundle();
  cur.instagram.cards[1].headline = editByUser(cur.instagram.cards[1].headline, '내가 고친 제목');

  const { merged, report } = mergeBundle(cur, incoming(), 'all');
  assert.equal(merged.instagram.cards[1].headline.value, '새 제목 c2');
  assert.ok(report.overwritten.includes('instagram.cards.c2.headline'));
});

test('부분 생성 결과가 기존 내용을 지우지 않는다', () => {
  const cur = makeBundle();
  // 카드 2만 재생성된 경우 — 나머지 필드는 incoming 에 없다
  const partial = { instagram: { cards: [{ id: 'c2', headline: field('새 제목만') }] } };

  const { merged } = mergeBundle(cur, partial, 'text');
  const c2 = merged.instagram.cards.find((c) => c.id === 'c2');
  assert.equal(c2.headline.value, '새 제목만');
  assert.equal(c2.body.value, '본문 c2', '건드리지 않은 필드가 사라졌다');
  assert.equal(merged.instagram.caption.value, '원래 캡션');
});

test('버튼 옆 안내 문구가 무엇이 유지되는지 알려준다', () => {
  const cur = makeBundle();
  cur.instagram.cards[1].headline = editByUser(cur.instagram.cards[1].headline, '내가 고친 제목');

  assert.match(describeLocks(cur, 'text'), /1개 항목은 유지/);
  assert.match(describeLocks(cur, 'photo'), /문구는 모두 유지/);
  assert.match(describeLocks(cur, 'all'), /1개 항목이 모두 사라집니다/);
});
