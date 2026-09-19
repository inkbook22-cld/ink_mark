/**
 * 비용 추정.
 *
 * 공급자 청구액과 일치하지 않는다. 화면에는 항상 그 사실을 같이 띄운다.
 * 예산은 "다음 요청 전에 잔여를 검사"하는 용도일 뿐 강제 한도가 아니다.
 */

/** 생성 전 예상 비용. 사용자가 시작 버튼을 누르기 전에 보여준다. */
export function estimateBeforeRun({ config, cardCount = 7, blogImages = 4, providedPhotos = 0 }) {
  const img = config.image[config.image.default];
  const price = config.pricing.image[img.model]?.[img.quality] ?? 0;

  // 사용자가 넣은 사진은 생성하지 않는다
  const toGenerate = Math.max(0, cardCount + blogImages - providedPhotos);
  const imageUsd = toGenerate * price;
  // 원고는 이미지에 비해 미미하지만 0으로 두면 사용자가 "공짜"로 오해한다
  const textUsd = 0.03;

  return {
    imageCount: toGenerate,
    imageUsd: round(imageUsd),
    textUsd,
    totalUsd: round(imageUsd + textUsd),
    note: '추정치입니다. 공급자 청구액과 다를 수 있습니다.',
  };
}

/** 실제 호출 뒤 사용량으로 계산. usage 가 없는 공급자는 단가표로 떨어진다. */
export function costOfImage({ config, provider, model, usage }) {
  const table = config.pricing.image[model];
  if (!table) return null;
  const quality = config.image[provider]?.quality ?? 'default';
  return round(table[quality] ?? table.default ?? 0);
}

export function costOfText({ usage }) {
  if (!usage) return null;
  // 단가는 모델마다 다르고 자주 바뀐다. 정확한 값이 필요하면 config 에 표를 추가한다.
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return round((inTok / 1e6) * 5 + (outTok / 1e6) * 15);
}

/**
 * 다음 요청을 보내도 되는지 본다.
 * 넘었다고 호출을 막지는 않는다 — 호출자가 사용자에게 물어본다.
 */
export function checkBudget({ budgetUsd, spentUsd, nextUsd }) {
  if (budgetUsd == null) return { ok: true };
  const after = spentUsd + nextUsd;
  return {
    ok: after <= budgetUsd,
    budgetUsd,
    spentUsd: round(spentUsd),
    nextUsd: round(nextUsd),
    remainingUsd: round(budgetUsd - spentUsd),
    message: after > budgetUsd
      ? `예산 $${budgetUsd} 중 $${round(spentUsd)}를 썼습니다. 다음 요청 $${round(nextUsd)}를 더하면 초과합니다.`
      : null,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;
