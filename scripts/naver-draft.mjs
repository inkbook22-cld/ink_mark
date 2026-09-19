#!/usr/bin/env node
/**
 * 네이버 블로그 임시저장 CLI.
 *
 * 앱이 붙기 전까지 이 흐름을 손으로 돌려보기 위한 것이다.
 * 로그인은 자동화하지 않는다 — 창이 뜨면 직접 로그인하면 되고, 세션은 프로필에 남는다.
 *
 * 사용:
 *   node scripts/naver-draft.mjs --blog-id myblog --title "제목" --file 원고.md \
 *     [--images ./out] [--profile-dir ~/.ink/profiles/myblog] [--ime] [--headless]
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openSession, ensureLoggedIn } from '../src/publish/naver/session.mjs';
import { saveDraft, loadProfile } from '../src/publish/naver/uploader.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args['blog-id'] || !args.file) {
  console.error('사용: node scripts/naver-draft.mjs --blog-id <id> --title <제목> --file <원고.md>');
  process.exit(2);
}

const markdown = await readFile(args.file, 'utf8');
const title = args.title ?? path.basename(args.file, path.extname(args.file));
const profileDir = args['profile-dir'] ?? path.join(os.homedir(), '.ink', 'profiles', args['blog-id']);
const profile = await loadProfile();

if (!profile.verifiedAt) {
  console.warn(
    '\n경고: profile.json 의 셀렉터가 실제 네이버에서 아직 검증되지 않았다(verifiedAt: null).\n' +
    '      실패하면 셀렉터부터 의심할 것. 실패해도 원고와 이미지는 그대로 남는다.\n',
  );
}

const { context, page } = await openSession({ profileDir, headless: Boolean(args.headless) });

try {
  await ensureLoggedIn(page, profile, {
    onWaiting: () => console.log('로그인 창을 띄웠다. 창에서 직접 로그인하면 이어서 진행한다.'),
  });

  const result = await saveDraft(
    page,
    {
      blogId: args['blog-id'],
      title,
      markdown,
      imageBase: args.images ? path.resolve(args.images) : path.dirname(path.resolve(args.file)),
      typeMode: args.ime ? 'ime' : 'key',
      onProgress: (s) => process.stdout.write(`\r  ${s}${' '.repeat(20)}`),
    },
    profile,
  );

  console.log('\n');
  console.log(`상태: ${result.status}`);
  console.log(`집계: ${JSON.stringify(result.counts)}`);
  if (result.verified) console.log(`검증: ${JSON.stringify(result.verified)}`);
  if (result.issues.length) {
    console.log('\n지적:');
    for (const i of result.issues) console.log(`  - ${i}`);
  }

  // 실패해도 앱은 자동 재시도하지 않는다. 중복 글이 생기는 쪽이 더 나쁘다(D1).
  if (result.status !== '저장 확인됨') {
    console.log('\n자동 재시도하지 않는다. 네이버에서 임시글 목록을 직접 확인할 것.');
    process.exitCode = 1;
  }
} finally {
  if (!args.keep) await context.close();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}
