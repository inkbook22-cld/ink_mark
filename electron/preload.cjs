/**
 * 화면과 메인 사이의 유일한 통로.
 *
 * 화면은 여기 적힌 것만 부를 수 있다. Node 도, 파일 시스템도, API 키도 닿지 않는다.
 * 새 기능을 붙일 때 여기에 한 줄을 추가하는 것이 곧 보안 검토가 된다.
 */
const { contextBridge, ipcRenderer } = require('electron');

const call = (method, payload) => ipcRenderer.invoke('ink:call', { method, payload });

contextBridge.exposeInMainWorld('ink', {
  // 브랜드
  listBrands: () => call('brands:list'),
  saveBrand: (brand) => call('brands:save', { brand }),

  // 키 — 값을 읽는 함수는 없다. 설정 여부만 알 수 있다.
  keyStatus: () => call('keys:status'),
  setKey: (provider, value) => call('keys:set', { provider, value }),

  // 생성
  estimate: (opts) => call('estimate', opts),
  generate: (opts) => call('generate', opts),
  regenerate: (opts) => call('regenerate', opts),
  describeLocks: (projectId, mode) => call('locks:describe', { projectId, mode }),

  // 편집·버전
  editField: (projectId, path, value) => call('field:edit', { projectId, path, value }),
  getBundle: (projectId, version) => call('bundle:get', { projectId, version }),
  revert: (projectId, version) => call('bundle:revert', { projectId, version }),
  validate: (projectId) => call('validate', { projectId }),

  // 발행
  naverDraft: (opts) => call('naver:draft', opts),
  openFolder: (p) => call('shell:open', { path: p }),

  // 진행 상황
  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ink:progress', handler);
    return () => ipcRenderer.removeListener('ink:progress', handler);
  },
});
