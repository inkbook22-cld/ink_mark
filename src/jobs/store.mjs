/**
 * 저장소 — SQLite(node 내장). 네이티브 의존성이 없어 패키징이 단순하다.
 *
 * 나중에 바꾸기 비싼 두 번째 코드다. 여기서 가장 중요한 표는 api_calls 다.
 *
 * 유료 API 호출은 "보냈는데 응답을 못 받은" 상태가 존재한다. 이때 그냥 다시 보내면
 * 사용자가 돈을 두 번 낸다. 그래서 호출 '전에' pending 을 남기고, 응답을 받으면
 * done 으로 바꾼다. 앱이 죽었다 살아나면 pending 으로 남은 것은 unknown 이 되고,
 * 자동으로 재발행하지 않는다 — 사용자가 판단한다.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, title TEXT NOT NULL, dir TEXT NOT NULL,
  budget_usd REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

-- 재생성 직전 버전을 남긴다 (D4 규칙 5: 되돌리기)
CREATE TABLE IF NOT EXISTS bundle_versions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL,
  label TEXT, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bundle_project ON bundle_versions(project_id, version DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  started_at TEXT, finished_at TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS idx_steps_job ON steps(job_id);

-- 유료 호출 장부. status: pending | done | failed | unknown
CREATE TABLE IF NOT EXISTS api_calls (
  id TEXT PRIMARY KEY, job_id TEXT, provider TEXT NOT NULL, model TEXT,
  kind TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT,
  status TEXT NOT NULL, usage_json TEXT, cost_usd REAL, error TEXT,
  started_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS idx_calls_job ON api_calls(job_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_key ON api_calls(idempotency_key);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, rel_path TEXT NOT NULL,
  sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
`;

const SCHEMA_VERSION = '1';
const now = () => new Date().toISOString();
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export class Store {
  /** @param {string} dbPath */
  constructor(dbPath) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING')
      .run('schemaVersion', SCHEMA_VERSION);
  }

  close() { this.db.close(); }

  // ── 브랜드 ────────────────────────────────────────────────────
  saveBrand(brand) {
    const id = brand.id ?? randomUUID();
    const t = now();
    this.db.prepare(
      `INSERT INTO brands(id,name,json,created_at,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, json=excluded.json, updated_at=excluded.updated_at`,
    ).run(id, brand.name, JSON.stringify({ ...brand, id }), t, t);
    return id;
  }

  getBrand(id) {
    const row = this.db.prepare('SELECT json FROM brands WHERE id=?').get(id);
    return row ? JSON.parse(row.json) : null;
  }

  listBrands() {
    return this.db.prepare('SELECT json FROM brands ORDER BY updated_at DESC').all().map((r) => JSON.parse(r.json));
  }

  // ── 프로젝트 ──────────────────────────────────────────────────
  createProject({ brandId, title, dir, budgetUsd = null }) {
    const id = randomUUID();
    const t = now();
    this.db.prepare(
      'INSERT INTO projects(id,brand_id,title,dir,budget_usd,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    ).run(id, brandId, title, dir, budgetUsd, t, t);
    return id;
  }

  getProject(id) {
    return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) ?? null;
  }

  // ── 콘텐츠 묶음 버전 ──────────────────────────────────────────
  /** 새 버전을 쌓는다. 덮어쓰지 않으므로 되돌리기가 가능하다(D4 규칙 5). */
  saveBundle(projectId, bundle, label = null) {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM bundle_versions WHERE project_id=?')
      .get(projectId);
    const version = row.v + 1;
    this.db.prepare(
      'INSERT INTO bundle_versions(id,project_id,version,label,json,created_at) VALUES(?,?,?,?,?,?)',
    ).run(randomUUID(), projectId, version, label, JSON.stringify(bundle), now());
    return version;
  }

  getBundle(projectId, version = null) {
    const row = version
      ? this.db.prepare('SELECT json FROM bundle_versions WHERE project_id=? AND version=?').get(projectId, version)
      : this.db.prepare('SELECT json FROM bundle_versions WHERE project_id=? ORDER BY version DESC LIMIT 1').get(projectId);
    return row ? JSON.parse(row.json) : null;
  }

  listBundleVersions(projectId) {
    return this.db
      .prepare('SELECT version, label, created_at FROM bundle_versions WHERE project_id=? ORDER BY version DESC')
      .all(projectId);
  }

  // ── 작업 ──────────────────────────────────────────────────────
  createJob(projectId, kind) {
    const id = randomUUID();
    const t = now();
    this.db.prepare('INSERT INTO jobs(id,project_id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, projectId, kind, 'running', t, t);
    return id;
  }

  setJobStatus(jobId, status) {
    this.db.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run(status, now(), jobId);
  }

  /** 이미 끝난 단계인지 — 앱이 재시작돼도 완료 단계부터 이어가기 위한 것. */
  isStepDone(jobId, name) {
    const row = this.db.prepare("SELECT 1 FROM steps WHERE job_id=? AND name=? AND status='done'").get(jobId, name);
    return Boolean(row);
  }

  startStep(jobId, name) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO steps(id,job_id,name,status,started_at) VALUES(?,?,?,?,?)')
      .run(id, jobId, name, 'running', now());
    return id;
  }

  finishStep(stepId, status, error = null) {
    this.db.prepare('UPDATE steps SET status=?, finished_at=?, error=? WHERE id=?')
      .run(status, now(), error, stepId);
  }

  listSteps(jobId) {
    return this.db.prepare('SELECT name,status,error,started_at,finished_at FROM steps WHERE job_id=? ORDER BY started_at').all(jobId);
  }

  // ── 유료 호출 장부 ────────────────────────────────────────────
  /**
   * 호출 '전에' 부른다. 같은 idempotencyKey 로 이미 성공한 호출이 있으면
   * reused 를 돌려준다 — 재시작 후 같은 요청을 다시 돈 내고 보내지 않기 위함이다.
   */
  beginCall({ jobId, provider, model, kind, idempotencyKey, requestHash }) {
    const prior = this.db.prepare('SELECT * FROM api_calls WHERE idempotency_key=?').get(idempotencyKey);
    if (prior?.status === 'done') return { id: prior.id, reused: true, prior };
    if (prior) {
      this.db.prepare("UPDATE api_calls SET status='pending', started_at=?, error=NULL WHERE id=?")
        .run(now(), prior.id);
      return { id: prior.id, reused: false, prior };
    }
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO api_calls(id,job_id,provider,model,kind,idempotency_key,request_hash,status,started_at)
       VALUES(?,?,?,?,?,?,?,'pending',?)`,
    ).run(id, jobId ?? null, provider, model ?? null, kind, idempotencyKey, requestHash ?? null, now());
    return { id, reused: false };
  }

  endCall(id, { status, usage = null, costUsd = null, error = null }) {
    this.db.prepare('UPDATE api_calls SET status=?, usage_json=?, cost_usd=?, error=?, finished_at=? WHERE id=?')
      .run(status, usage ? JSON.stringify(usage) : null, costUsd, error, now(), id);
  }

  /**
   * 앱이 비정상 종료한 뒤 부른다. pending 으로 남은 호출은 성공 여부를 알 수 없으므로
   * unknown 으로 표시하고 자동 재발행하지 않는다.
   * @returns {number} 표시된 개수
   */
  markOrphanedCalls() {
    const r = this.db.prepare("UPDATE api_calls SET status='unknown', finished_at=? WHERE status='pending'").run(now());
    return r.changes;
  }

  listUnknownCalls() {
    return this.db.prepare("SELECT id,provider,model,kind,started_at FROM api_calls WHERE status='unknown'").all();
  }

  /** 프로젝트가 지금까지 쓴 비용 추정치. */
  spentUsd(jobIds) {
    if (!jobIds?.length) return 0;
    const q = `SELECT COALESCE(SUM(cost_usd),0) AS s FROM api_calls WHERE status='done' AND job_id IN (${jobIds.map(() => '?').join(',')})`;
    return this.db.prepare(q).get(...jobIds).s;
  }

  // ── 산출물 ────────────────────────────────────────────────────
  recordArtifact({ projectId, kind, relPath, buffer, version = 1 }) {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO artifacts(id,project_id,kind,rel_path,sha256,bytes,version,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(id, projectId, kind, relPath, sha256(buffer), buffer.length, version, now());
    return id;
  }

  listArtifacts(projectId) {
    return this.db.prepare('SELECT kind,rel_path,sha256,bytes,version,created_at FROM artifacts WHERE project_id=? ORDER BY created_at').all(projectId);
  }
}
