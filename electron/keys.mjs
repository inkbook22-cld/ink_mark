/**
 * API 키 보관 — OS 보안 저장소(Electron safeStorage).
 *
 * macOS Keychain / Windows DPAPI 로 암호화해 디스크에 둔다. keytar 는 유지보수가
 * 끝났으므로 쓰지 않는다.
 *
 * 이 모듈은 메인·작업 프로세스에서만 부른다. 렌더러(화면)는 키를 절대 받지 않는다.
 * 화면이 알 수 있는 것은 "키가 설정되어 있는가"뿐이다.
 */

import { safeStorage, app } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const file = () => path.join(app.getPath('userData'), 'keys.bin');

async function readAll() {
  try {
    const buf = await readFile(file());
    if (!safeStorage.isEncryptionAvailable()) return {};
    return JSON.parse(safeStorage.decryptString(buf));
  } catch {
    return {};
  }
}

async function writeAll(map) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('이 컴퓨터에서 보안 저장소를 쓸 수 없습니다. 키를 저장하지 않았습니다.');
  }
  await mkdir(path.dirname(file()), { recursive: true });
  await writeFile(file(), safeStorage.encryptString(JSON.stringify(map)), { mode: 0o600 });
}

export async function setKey(provider, value) {
  const all = await readAll();
  if (value) all[provider] = value;
  else delete all[provider];
  await writeAll(all);
}

/** 작업 프로세스에서만 부른다. */
export async function getKey(provider) {
  return (await readAll())[provider] ?? null;
}

/**
 * 화면에 보여줄 상태. 키 값 자체는 절대 나가지 않는다.
 * 끝 4자리만 남겨 사용자가 어느 키인지 알아볼 수 있게 한다.
 */
export async function keyStatus() {
  const all = await readAll();
  const mask = (v) => (v ? `····${v.slice(-4)}` : null);
  return {
    available: safeStorage.isEncryptionAvailable(),
    openai: { set: Boolean(all.openai), hint: mask(all.openai) },
    gemini: { set: Boolean(all.gemini), hint: mask(all.gemini) },
  };
}
