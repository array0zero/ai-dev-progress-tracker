# DESIGN.md — 設計書

project_id: ai-dev-progress-tracker  
version: 1.3  
date: 2026-09-01  
source: PLAN.md v1.2 + 実機検証結果（2026-09-01）+ Windows実機不具合修正（2026-09-01）

## v1.3変更点

- Windows実機で `codex` の実体が `.cmd` shim のため `spawn(shell:false)` で起動できず、進捗生成が全て失敗する不具合を修正。
- process runnerを、Windowsで `PATH` + `PATHEXT` から実体を解決し、`.cmd` / `.bat` shim は `%ComSpec% /d /s /c` 経由で（それでもshellを介さず）起動するように変更。`gh` / `git` / `codex` すべてこの経路を共有する。
- Codex実行直前検査で「versionを取得できなかった（spawn失敗 / timeout / 非0終了）」場合を `CODEX_VERSION_CHECK_FAILED`、認証状態を取得できなかった場合を `CODEX_AUTH_CHECK_FAILED` として、`CODEX_VERSION_UNSUPPORTED`（取得できたが下限未満）/ `VERSION_PARSE_ERROR`（取得できたが抽出不能）と区別する。
- 設計判断ログにD021を追加。

## v1.2変更点

- npm `12.0.2`は依存パッケージのinstall scriptを既定でblockするため、`package.json`へ`allowScripts`フィールドを追加し、`better-sqlite3`と`esbuild`のみをバージョンピンで許可する。
- `better-sqlite3`は型定義を同梱しないため、`devDependencies`へ型定義専用パッケージ`@types/better-sqlite3`を`9.6.0`固定で追加する。ランタイム依存・採用技術は変更しない。
- 上記はdependencies/devDependenciesの既存バージョン指定・ディレクトリ構成を変更しない。npm `12.0.2`と既存16件の完全一致固定は維持する。
- 設計判断ログにD019・D020を追加。

## v1.1変更点

- Node.js: 完全一致指定を廃止し、`>=24.15.0 <25`へ変更。
- Git: 既存の最低バージョン`>=2.45.0`を維持。今回の実測値は未提示。
- GitHub CLI (`gh`): 完全一致指定を廃止し、`>=2.98.0`へ変更。
- Codex CLI: 完全一致指定を廃止し、`>=0.146.0`へ変更。
- Codex認証要件`Logged in using ChatGPT`とモデル`gpt-5.6-terra`は維持。
- npm package manager `12.0.2`と、package.jsonのdependencies/devDependencies 16件（合計17件のnpm package指定）の完全一致固定は変更しない。
- CIのNode.jsは実機検証済み下限と同じ`24.15.0`を使用する。
- `doctor`、server起動時、Codex実行直前のversion判定は文字列完全一致ではなくsemantic version比較を使用する。
- 本v1.1のversion要件は、旧AGENTS.md等に残るv1.0の外部CLI完全一致記述より優先する。

## 0. 受入検査結果

**判定: 合格。設計へ進む。**

| 検査項目 | 判定 | 確認結果 |
|---|---|---|
| 受け入れ基準のないユーザーストーリーがある | 合格 | US-01〜US-07の全てにGiven/When/Then形式の受け入れ基準がある |
| 非機能要件が数値化されていない | 合格 | 表示2秒、起動10/10、生成8/10、復元8/10、失敗可視化100%、秘密情報保存0件、追加コスト0円等で判定可能 |
| MUST機能が曖昧で実装判断できない | 合格 | F1〜F7の未確定点はPLANで設計AIへ明示委譲されており、本設計で具体化する |

---

## 1. アーキテクチャ概要

### 構成図

```text
┌────────────────────────── 対象ローカルGitリポジトリ ──────────────────────────┐
│                                                                            │
│  git commit                                                                │
│     │                                                                      │
│     └─ .git/hooks/post-commit                                              │
│           │                                                                │
│           └─ tracker CLI: hook-commit                                      │
│                ├─ commitをDBへ登録                                         │
│                ├─ generation_runを重複排除付きでqueued化                   │
│                └─ detached workerを起動して即時終了                        │
│                                                                            │
│  git push                                                                  │
│     │                                                                      │
│     └─ .git/hooks/pre-push                                                 │
│           └─ tracker CLI: hook-backup                                      │
│                ├─ backup_runをqueued化                                     │
│                └─ detached workerを起動してpush自体は妨げない              │
└────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────── AI Dev Progress Tracker ────────────────────────────────┐
│                                                                            │
│  Fastify HTTP server (127.0.0.1:4317)                                      │
│      ├─ REST API                                                           │
│      └─ React/Vite静的UI                                                   │
│                                                                            │
│  SQLite                                                                    │
│      ├─ projects                                                           │
│      ├─ commits                                                            │
│      ├─ evidence                                                           │
│      ├─ generation_runs                                                    │
│      ├─ run_evidence                                                       │
│      ├─ progress_snapshots                                                 │
│      └─ backup_runs                                                        │
│                                                                            │
│  Generation worker                                                        │
│      ├─ local git: commit metadata / diff                                  │
│      ├─ gh CLI: Issue / Pull Request                                       │
│      ├─ Codex CLI: structured progress generation                          │
│      ├─ Zod + evidence参照整合性検証                                       │
│      └─ snapshot保存 / failed・partial可視化                               │
│                                                                            │
│  Backup worker                                                             │
│      ├─ DB内容を決定的JSONへexport                                         │
│      ├─ SHA-256 manifest生成                                               │
│      ├─ 専用Private repoへcommit                                           │
│      └─ push                                                               │
│                                                                            │
│  Restore CLI                                                               │
│      ├─ Private repo clone/pull                                            │
│      ├─ checksum / schema / FK検証                                         │
│      ├─ 新規SQLiteへimport                                                 │
│      ├─ atomic replace                                                     │
│      └─ 対象repoへhook再設置                                               │
└────────────────────────────────────────────────────────────────────────────┘
        │                         │                            │
        ▼                         ▼                            ▼
 GitHub CLI >=2.98.0        Codex CLI >=0.146.0      Backup Private repository
 既存gh認証を利用            ChatGPT認証のみ許可       <login>/ai-dev-progress-tracker-backup
```

### 各構成要素の責務

- **Web UI**
  - プロジェクト登録。
  - 全プロジェクトの現在地・完了事項・次の作業・情報元リポジトリ・最終反映commit表示。
  - プロジェクト詳細の重要判断・理由・根拠表示。
  - 生成失敗・部分復元・バックアップ失敗の状態表示。
- **Fastify API**
  - UI用read/write API。
  - 入力検証。
  - ローカルホスト以外からのアクセス拒否。
- **SQLite**
  - ローカルの正本。
  - 生成履歴、根拠、バックアップ実行状態を保持。
- **Git hook管理**
  - 登録済み各プロジェクトの`.git/hooks/post-commit`と`.git/hooks/pre-push`へ管理ブロックを追加。
  - `core.hooksPath`が設定済みのrepositoryとlinked worktreeはMVP対象外として登録時に拒否する。
  - 既存hookの先頭がshebangで始まる場合は内容を保持したまま追記。
  - 既存hookが存在しshebangがない場合は登録を失敗させ、既存hookを変更しない。
- **Generation worker**
  - commit単位でrunを1件だけ作成する。
  - project単位のDB leaseでworkerを1プロセスに直列化し、queued runを`detected_at ASC, id ASC`で処理する。
  - 対象プロジェクトに紐付いた1リポジトリだけから根拠を取得。
  - Codex CLIへJSON Schema制約付きで生成依頼。
  - 4必須項目の形式・根拠IDを検証。
- **Recovery**
  - 進捗欠落時に最新commitと取得可能なGitHub根拠から再生成。
  - 全4項目confirmedなら`complete`。
  - 1〜3項目confirmedなら`partial`。
  - 0項目confirmedなら`unrecoverable`。
- **Backup**
  - 全登録プロジェクトの対応関係、commit、根拠、generation run、progress snapshotを1つの決定的JSONへexport。
  - 専用Private repositoryへ保存。
- **Restore**
  - バックアップを検証後、新しいDBへ全件import。
  - import完了後にDBをatomic replace。
  - `worker_leases`は復元対象外で、復元後は空から開始。
- **外部CLI**
  - `gh`: GitHub認証・repository/Issue/PR操作。
  - `codex`: ChatGPT認証済みCLIによる生成。
  - API keyを標準経路として使用しない。

---

## 2. 技術選定

技術選定の理由は記載しない。npm packageは完全一致、Node.js/Git/gh/Codexは下記version constraintで固定する。

| レイヤ | 採用技術 | バージョン | 選定理由 | 却下した候補と理由 |
|---|---|---:|---|---|
| ランタイム | Node.js | `>=24.15.0 <25` | — | — |
| パッケージ管理 | npm | `12.0.2`（完全一致） | — | — |
| VCS CLI | Git | `>=2.45.0` | — | — |
| 言語 | TypeScript | 7.0.2 | — | — |
| HTTPフレームワーク | Fastify | 5.12.1 | — | — |
| 静的配信 | @fastify/static | 10.1.3 | — | — |
| UI | React | 19.2.8 | — | — |
| UI DOM | react-dom | 19.2.8 | — | — |
| ビルド | Vite | 8.2.2 | — | — |
| React Vite plugin | @vitejs/plugin-react | 6.1.1 | — | — |
| データストア | SQLite + better-sqlite3 | 13.0.3 | — | — |
| スキーマ検証 | Zod | 4.5.4 | — | — |
| Lint/Format | @biomejs/biome | 2.5.11 | — | — |
| 単体/結合テスト | Vitest | 4.1.11 | — | — |
| E2E | @playwright/test | 1.62.1 | — | — |
| TS実行補助 | tsx | 4.23.13 | — | — |
| React型 | @types/react | 19.2.18 | — | — |
| React DOM型 | @types/react-dom | 19.2.5 | — | — |
| Node型 | @types/node | 24.13.3 | — | — |
| better-sqlite3型 | @types/better-sqlite3 | 9.6.0 | — | — |
| GitHub連携 | GitHub CLI (`gh`) | `>=2.98.0` | — | — |
| AI実行 | OpenAI Codex CLI | `>=0.146.0` | — | — |
| AIモデル | GPT-5.6 Terra | `gpt-5.6-terra` | — | — |
| CI checkout action | actions/checkout | 7.0.1 | — | — |
| CI Node setup action | actions/setup-node | 7.0.0 | — | — |
| 認証 | ローカルUI認証なし / GitHubはgh認証 / AIはCodex ChatGPT認証 | 固定 | — | — |
| ホスティング | localhost | `127.0.0.1:4317` | — | — |

### package.json固定値

実装時の`package.json`は以下の依存バージョンを**完全一致**で使用する。`^`、`~`は付けない。

```json
{
  "name": "ai-dev-progress-tracker",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "packageManager": "npm@12.0.2",
  "engines": {
    "node": ">=24.15.0 <25",
    "npm": "12.0.2"
  },
  "scripts": {
    "dev": "npm run build:web && tsx watch src/server/index.ts",
    "build": "npm run typecheck && npm run build:server && npm run build:web",
    "build:server": "tsc -p tsconfig.server.json",
    "build:web": "vite build",
    "start": "node dist/server/index.js",
    "cli": "node dist/cli/index.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "biome ci .",
    "format": "biome check --write .",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "playwright test",
    "test:all": "npm run lint && npm run typecheck && npm test && npm run build && npm run test:e2e",
    "eval:generation": "tsx scripts/eval-generation.ts",
    "eval:recovery": "tsx scripts/eval-recovery.ts",
    "verify:secrets": "tsx scripts/verify-no-secrets.ts"
  },
  "dependencies": {
    "@fastify/static": "10.1.3",
    "better-sqlite3": "13.0.3",
    "fastify": "5.12.1",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.11",
    "@playwright/test": "1.62.1",
    "@types/node": "24.13.3",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "@vitejs/plugin-react": "6.1.1",
    "tsx": "4.23.13",
    "typescript": "7.0.2",
    "vite": "8.2.2",
    "vitest": "4.1.11",
    "@types/better-sqlite3": "9.6.0"
  },
  "allowScripts": {
    "esbuild@0.28.2": true,
    "better-sqlite3@13.0.3": true
  }
}
```

`allowScripts`はnpm `12.0.2`が依存のinstall scriptを既定でblockするための許可リストである。
`better-sqlite3`（採用DBドライバのnativeビルド）と`esbuild`（Vite build依存）のみを、レビュー済みバージョンにピンして許可する。
新たな依存追加でinstall scriptが増えた場合は`npm install-scripts approve <pkg>`で同フィールドへ追記する。
このフィールドはdependencies/devDependenciesのバージョン指定を変更しない。

### 外部CLI・ランタイム要件

server起動時および`doctor`で以下を検査する。Codex実行直前にはCodex CLI versionと認証を再検査する。

```text
process.versions.node             -> >=24.15.0 かつ <25.0.0
git --version                     -> >=2.45.0
gh --version                      -> >=2.98.0
gh auth status --active --hostname github.com -> exit 0
codex --version                   -> >=0.146.0
codex login status               -> stderr/stdoutに "Logged in using ChatGPT" を含む
```

version比較は以下で固定する。

1. version文字列から最初の`MAJOR.MINOR.PATCH`を正規表現`/(\d+)\.(\d+)\.(\d+)/`で抽出する。
2. 抽出できない場合は`VERSION_PARSE_ERROR`で失敗する。
3. prerelease/build metadataが後続していても、MVPでは抽出した3整数だけを比較する。
4. `[major, minor, patch]`を左から整数比較する。
5. Node.jsは`>=24.15.0`かつ`<25.0.0`を満たす場合だけ合格。
6. Gitは`>=2.45.0`、ghは`>=2.98.0`、Codexは`>=0.146.0`を満たす場合だけ合格。
7. 上限はNode.jsだけに設定する。Git/gh/Codexは上位versionを許容する。
8. version比較用の追加npm packageは導入しない。`src/server/config.ts`にpure functionとして実装し、server起動時・doctor・Codex adapterから共有する。

最低version未満の場合のerror code:

```text
Node.js -> NODE_VERSION_UNSUPPORTED
Git     -> GIT_VERSION_UNSUPPORTED
gh      -> GH_VERSION_UNSUPPORTED
Codex   -> CODEX_VERSION_UNSUPPORTED
```

Codex実行直前検査は、以下を区別する。

```text
CODEX_VERSION_CHECK_FAILED -> `codex --version` を実行できなかった（spawn失敗 / timeout / 非0終了）
VERSION_PARSE_ERROR        -> 実行できたが出力から MAJOR.MINOR.PATCH を抽出できない
CODEX_VERSION_UNSUPPORTED  -> versionを抽出できたが `>=0.146.0` を満たさない
CODEX_AUTH_CHECK_FAILED    -> `codex login status` を実行できなかった（spawn失敗 / timeout）
AI_AUTH_NOT_CHATGPT        -> ChatGPT認証ではない（API key認証）
CODEX_AUTH_REQUIRED        -> 未ログイン
```

`codex login status`がAPI key認証を示す場合は`AI_AUTH_NOT_CHATGPT`として標準経路を停止する。

### 外部CLIのプロセス起動（全OS共通）

外部CLI（`git` / `gh` / `codex`）は共通の process runner から起動し、shellは介さない（`spawn` の `shell:false`）。
Windowsでは `spawn(shell:false)` が `.cmd` / `.bat` を直接起動できない（Node CVE-2024-27980対応）ため、process runnerが次を行う。

1. コマンドが素の名前（パス区切り・拡張子なし）なら `PATH` × `PATHEXT` から実体を解決する。
2. 実体が `.exe` / `.com` なら解決した絶対パスを直接 `spawn` する。
3. 実体が `.cmd` / `.bat`（npm等が作るshim）なら `%ComSpec% /d /s /c "<実体> <エスケープ済み引数>"` を `windowsVerbatimArguments:true` で `spawn` する（cmd.exe自体は `.exe` なので `shell:false` のまま起動できる）。引数エスケープはcross-spawn相当。
4. 解決できなければ従来どおり `spawn` に委ね、`error` イベントで失敗させる。

非Windowsでは従来どおりコマンド名をそのまま `spawn` する。

### 対応OS

- Windows 11 24H2以降 + Git for Windows
- macOS 14以降
- Ubuntu 24.04 LTS以降

---

## 3. ディレクトリ構成

プロジェクトルートからの予定ファイルを全て記載する。

```text
ai-dev-progress-tracker/
├── .github/
│   └── workflows/
│       └── ci.yml
├── db/
│   └── migrations/
│       └── 001_init.sql
├── schemas/
│   ├── backup-v1.schema.json
│   └── progress-output.schema.json
├── scripts/
│   ├── eval-generation.ts
│   ├── eval-recovery.ts
│   └── verify-no-secrets.ts
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── doctor.ts
│   │   │   ├── hook-backup.ts
│   │   │   ├── hook-commit.ts
│   │   │   └── restore.ts
│   │   └── index.ts
│   ├── server/
│   │   ├── adapters/
│   │   │   ├── codex.ts
│   │   │   ├── git.ts
│   │   │   ├── github.ts
│   │   │   └── process-runner.ts
│   │   ├── db/
│   │   │   ├── backup-repository.ts
│   │   │   ├── connection.ts
│   │   │   ├── lease-repository.ts
│   │   │   ├── migrations.ts
│   │   │   ├── progress-repository.ts
│   │   │   ├── project-repository.ts
│   │   │   └── run-repository.ts
│   │   ├── routes/
│   │   │   ├── backup.ts
│   │   │   ├── health.ts
│   │   │   ├── projects.ts
│   │   │   └── system.ts
│   │   ├── schemas/
│   │   │   ├── backup.ts
│   │   │   ├── progress.ts
│   │   │   └── project.ts
│   │   ├── security/
│   │   │   └── redaction.ts
│   │   ├── services/
│   │   │   ├── backup-service.ts
│   │   │   ├── generation-service.ts
│   │   │   ├── hook-service.ts
│   │   │   ├── project-service.ts
│   │   │   ├── recovery-service.ts
│   │   │   └── restore-service.ts
│   │   ├── app.ts
│   │   ├── config.ts
│   │   ├── index.ts
│   │   └── logging.ts
│   ├── shared/
│   │   ├── api.ts
│   │   └── domain.ts
│   ├── web/
│   │   ├── api/
│   │   │   └── client.ts
│   │   ├── components/
│   │   │   ├── EvidenceList.tsx
│   │   │   ├── ProgressSection.tsx
│   │   │   ├── ProjectCard.tsx
│   │   │   ├── RegisterProjectForm.tsx
│   │   │   └── StatusBanner.tsx
│   │   ├── pages/
│   │   │   ├── DashboardPage.tsx
│   │   │   └── ProjectDetailPage.tsx
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── styles.css
│   └── worker/
│       ├── backup-worker.ts
│       ├── generation-worker.ts
│       └── index.ts
├── tests/
│   ├── e2e/
│   │   ├── dashboard.spec.ts
│   │   ├── project-detail.spec.ts
│   │   └── registration.spec.ts
│   ├── fixtures/
│   │   ├── generation-cases.json
│   │   └── recovery-cases.json
│   ├── helpers/
│   │   ├── fake-codex.ts
│   │   ├── fake-gh.ts
│   │   ├── temp-repo.ts
│   │   └── test-db.ts
│   ├── integration/
│   │   ├── backup-flow.test.ts
│   │   ├── commit-generation-flow.test.ts
│   │   ├── db-migrations.test.ts
│   │   ├── project-registration.test.ts
│   │   ├── recovery-flow.test.ts
│   │   └── restore-flow.test.ts
│   └── unit/
│       ├── backup-export.test.ts
│       ├── codex-adapter.test.ts
│       ├── evidence-validation.test.ts
│       ├── git-adapter.test.ts
│       ├── github-adapter.test.ts
│       ├── hook-service.test.ts
│       ├── lease-repository.test.ts
│       ├── progress-schema.test.ts
│       ├── recovery-classifier.test.ts
│       ├── redaction.test.ts
│       └── smoke.test.ts
├── .env.example
├── .gitignore
├── .nvmrc
├── AGENTS.md
├── CLAUDE.md
├── DESIGN.md
├── PROGRESS.md
├── README.md
├── TASKS.md
├── biome.json
├── index.html
├── package-lock.json
├── package.json
├── playwright.config.ts
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
└── vitest.config.ts
```

### アプリデータ配置

デフォルト:

```text
~/.ai-dev-progress-tracker/
├── tracker.db
├── logs/
│   └── app.log
└── backup-repo/
```

テスト時のみ`TRACKER_DATA_DIR`で変更可能。

---

## 4. データモデル

### エンティティ定義

| エンティティ | フィールド | 型 | 必須 | 制約 | 説明 |
|---|---|---|---|---|---|
| projects | id | TEXT | Yes | UUID, PK | アプリ内project ID |
| projects | name | TEXT | Yes | 1〜120文字 | 表示名 |
| projects | local_path | TEXT | Yes | canonical realpath, UNIQUE | Git root |
| projects | repo_node_id | TEXT | Yes | UNIQUE | GitHub repository ID |
| projects | repo_owner | TEXT | Yes | GitHub owner | repository owner |
| projects | repo_name | TEXT | Yes | GitHub name | repository name |
| projects | repo_url | TEXT | Yes | `https://github.com/...` | canonical URL |
| projects | default_branch | TEXT | Yes | 非空 | GitHub default branch |
| projects | status | TEXT | Yes | active/local_missing | ローカル可用状態 |
| commits | project_id | TEXT | Yes | FK | project |
| commits | sha | TEXT | Yes | 40/64 hex, composite PK | commit |
| commits | parent_sha | TEXT | No | hex | 親commit |
| commits | message | TEXT | Yes | | commit subject/body |
| commits | authored_at | TEXT | Yes | ISO-8601 UTC | commit時刻 |
| commits | detected_at | TEXT | Yes | ISO-8601 UTC | hook検知時刻 |
| evidence | id | TEXT | Yes | UUID, PK | 根拠ID |
| evidence | project_id | TEXT | Yes | FK | project |
| evidence | kind | TEXT | Yes | commit/issue/pull_request | 根拠種別 |
| evidence | external_key | TEXT | Yes | | SHAまたは番号 |
| evidence | source_version | TEXT | Yes | | SHAまたはupdatedAt |
| evidence | title | TEXT | Yes | | 表示タイトル |
| evidence | url | TEXT | No | | GitHub URL |
| evidence | payload_json | TEXT | Yes | valid JSON | 生成入力に使った正規化payload |
| generation_runs | id | TEXT | Yes | UUID, PK | 生成実行ID |
| generation_runs | dedupe_key | TEXT | Yes | UNIQUE | `generation:<project>:<sha>`等 |
| generation_runs | project_id | TEXT | Yes | FK | project |
| generation_runs | commit_sha | TEXT | Yes | FK | 対象commit |
| generation_runs | mode | TEXT | Yes | generation/recovery | 処理種別 |
| generation_runs | trigger | TEXT | Yes | post_commit/registration/manual_recovery | 契機 |
| generation_runs | status | TEXT | Yes | queued/running/succeeded/partial/unrecoverable/failed | 状態 |
| generation_runs | error_code | TEXT | No | | 機械判定用 |
| generation_runs | error_message | TEXT | No | secret-redacted | 表示用 |
| run_evidence | run_id | TEXT | Yes | FK | generation run |
| run_evidence | evidence_id | TEXT | Yes | FK | evidence |
| progress_snapshots | id | TEXT | Yes | UUID, PK | snapshot |
| progress_snapshots | generation_run_id | TEXT | Yes | UNIQUE, FK | run |
| progress_snapshots | project_id | TEXT | Yes | FK | project |
| progress_snapshots | commit_sha | TEXT | Yes | FK | 最後に反映したcommit |
| progress_snapshots | recovery_status | TEXT | Yes | complete/partial/unrecoverable | 4項目判定 |
| progress_snapshots | current_position_json | TEXT | Yes | valid JSON | 現在地Field |
| progress_snapshots | completed_items_json | TEXT | Yes | valid JSON | 完了事項Field |
| progress_snapshots | next_actions_json | TEXT | Yes | valid JSON | 次の作業Field |
| progress_snapshots | decisions_json | TEXT | Yes | valid JSON | 判断事項Field |
| backup_runs | id | TEXT | Yes | UUID, PK | backup実行ID |
| backup_runs | trigger | TEXT | Yes | registration/pre_push/manual | 契機 |
| backup_runs | project_id | TEXT | No | FK | push元project |
| backup_runs | source_commit_sha | TEXT | No | | push時HEAD |
| backup_runs | status | TEXT | Yes | queued/running/succeeded/failed | 状態 |
| backup_runs | backup_repo | TEXT | Yes | `owner/name` | backup先 |
| backup_runs | backup_commit_sha | TEXT | No | | 成功時のbackup repo commit |
| backup_runs | error_code | TEXT | No | | 機械判定用 |
| backup_runs | error_message | TEXT | No | redacted | 表示用 |
| worker_leases | scope | TEXT | Yes | PK | `generation:<project-id>`または`backup` |
| worker_leases | owner_token | TEXT | Yes | UUID | worker所有token |
| worker_leases | heartbeat_at | TEXT | Yes | ISO-8601 UTC | lease heartbeat |

### 共通進捗情報の固定形式

`progress-output.schema.json`とZod schemaは同じ意味を持たせる。

```json
{
  "schemaVersion": 1,
  "currentPosition": {
    "status": "confirmed",
    "text": "現在地の要約",
    "evidenceIds": ["ev_..."]
  },
  "completedItems": {
    "status": "confirmed",
    "items": [
      {
        "text": "完了事項",
        "evidenceIds": ["ev_..."]
      }
    ],
    "evidenceIds": ["ev_..."]
  },
  "nextActions": {
    "status": "confirmed",
    "items": [
      {
        "text": "次の作業",
        "evidenceIds": ["ev_..."]
      }
    ],
    "evidenceIds": ["ev_..."]
  },
  "importantDecisions": {
    "status": "confirmed",
    "items": [
      {
        "decision": "判断事項",
        "rationale": "判断理由",
        "evidenceIds": ["ev_..."]
      }
    ],
    "evidenceIds": ["ev_..."]
  }
}
```

各4フィールドの`status`は`confirmed | needs_input`のみ。

- `confirmed`
  - field-level `evidenceIds`は1件以上。
  - 各itemの`evidenceIds`も1件以上。
  - 全evidence IDが当該runの`run_evidence`に存在する。
- `needs_input`
  - text型は`"要補完"`。
  - list型は`items: []`。
  - `evidenceIds: []`。
- evidenceに存在しないIDを1つでも返した場合はAI出力全体を不正として`failed`。
- `completedItems`と`nextActions`を`confirmed`にする場合、`items`は1件以上。
- `importantDecisions`は、入力根拠から「重要な判断事項なし」と確認できる場合に限り`status:"confirmed", items:[], evidenceIds:[...]`を許可する。UIはこの状態を「重要な判断事項: なし」と表示する。
- 判断事項の有無自体を根拠から確定できない場合は`importantDecisions.status="needs_input"`とする。

### 復元結果の機械判定

```text
confirmed field数 = 4 -> complete
confirmed field数 = 1..3 -> partial
confirmed field数 = 0 -> unrecoverable
```

### リレーション

- projects 1:N commits
- projects 1:N evidence
- projects 1:N generation_runs
- generation_runs N:M evidence (`run_evidence`)
- generation_runs 1:0..1 progress_snapshots
- projects 1:N progress_snapshots
- projects 1:N backup_runs

### 具体スキーマ

`db/migrations/001_init.sql`は以下とする。

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  local_path TEXT NOT NULL UNIQUE,
  repo_node_id TEXT NOT NULL UNIQUE,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'local_missing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE commits (
  project_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  parent_sha TEXT,
  message TEXT NOT NULL,
  authored_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY(project_id, sha),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('commit', 'issue', 'pull_request')),
  external_key TEXT NOT NULL,
  source_version TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  captured_at TEXT NOT NULL,
  UNIQUE(project_id, kind, external_key, source_version),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE generation_runs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('generation', 'recovery')),
  trigger TEXT NOT NULL CHECK(trigger IN ('post_commit', 'registration', 'manual_recovery')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'partial', 'unrecoverable', 'failed')),
  detected_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  ai_provider TEXT NOT NULL DEFAULT 'codex_cli',
  ai_cli_version TEXT,
  ai_model TEXT NOT NULL DEFAULT 'gpt-5.6-terra',
  error_code TEXT,
  error_message TEXT,
  FOREIGN KEY(project_id, commit_sha) REFERENCES commits(project_id, sha) ON DELETE CASCADE
) STRICT;

CREATE TABLE run_evidence (
  run_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY(run_id, evidence_id),
  FOREIGN KEY(run_id) REFERENCES generation_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE progress_snapshots (
  id TEXT PRIMARY KEY,
  generation_run_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  recovery_status TEXT NOT NULL CHECK(recovery_status IN ('complete', 'partial', 'unrecoverable')),
  current_position_json TEXT NOT NULL CHECK(json_valid(current_position_json)),
  completed_items_json TEXT NOT NULL CHECK(json_valid(completed_items_json)),
  next_actions_json TEXT NOT NULL CHECK(json_valid(next_actions_json)),
  decisions_json TEXT NOT NULL CHECK(json_valid(decisions_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(generation_run_id) REFERENCES generation_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id, commit_sha) REFERENCES commits(project_id, sha) ON DELETE CASCADE
) STRICT;

CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK(trigger IN ('registration', 'pre_push', 'manual')),
  project_id TEXT,
  source_commit_sha TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
  backup_repo TEXT NOT NULL,
  backup_commit_sha TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE worker_leases (
  scope TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_generation_runs_project_status
  ON generation_runs(project_id, status, detected_at DESC);

CREATE INDEX idx_progress_snapshots_project_created
  ON progress_snapshots(project_id, created_at DESC);

CREATE INDEX idx_evidence_project_kind
  ON evidence(project_id, kind, captured_at DESC);

CREATE INDEX idx_backup_runs_status_queued
  ON backup_runs(status, queued_at DESC);

INSERT INTO schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
```

---

## 5. インターフェース仕様

全APIは`127.0.0.1:4317`でのみlistenする。Base pathは`/api`。

| メソッド | パス | 認証 | リクエスト | レスポンス | エラー |
|---|---|---|---|---|---|
| GET | `/api/health` | なし | なし | `{status:"ok", db:"ok"}` | 500 |
| GET | `/api/projects` | なし | なし | `ProjectSummary[]` | 500 |
| POST | `/api/projects` | なし | `{name,localPath,repository}` | `ProjectDetail` | 400/409/422/500 |
| GET | `/api/projects/:id` | なし | なし | `ProjectDetail` | 404/500 |
| POST | `/api/projects/:id/recover` | なし | `{}` | `{runId,status:"queued"}` | 404/409/422/500 |
| POST | `/api/backup` | なし | `{}` | `{backupRunId,status:"queued"}` | 409/500 |
| GET | `/api/system/status` | なし | なし | `SystemStatus` | 500 |

### POST `/api/projects`

Request:

```json
{
  "name": "my-project",
  "localPath": "/absolute/path/to/repo",
  "repository": "owner/repo"
}
```

固定検証順:

1. `localPath`を`realpath`化。
2. `git -C <path> rev-parse --show-toplevel`が成功。
3. 出力realpathと`localPath`が一致。
4. `git -C <path> rev-parse --absolute-git-dir`のrealpathが`<localPath>/.git`のrealpathと一致する。linked worktreeは拒否。
5. `git -C <path> config --get core.hooksPath`が値を返す場合は拒否。
6. `git -C <path> remote get-url origin`を取得する。raw URLは永続化・log出力しない。
7. originを`github.com/<owner>/<repo>`へ正規化。
8. request `repository`と一致。
9. `gh auth status --active --hostname github.com`が成功。
10. `gh repo view owner/repo --json id,nameWithOwner,url,visibility,defaultBranchRef`が成功。
11. 同じ`local_path`または`repo_node_id`が別projectへ登録済みなら409。
12. DB保存。
13. `post-commit`と`pre-push` hookを設置。
14. 最新HEAD commitを登録。
15. 進捗snapshotがないため`recovery` runを自動enqueue。
16. backup repositoryをensureし、registration契機backupをenqueue。

### ProjectSummary

```json
{
  "id": "uuid",
  "name": "my-project",
  "repository": "owner/repo",
  "repositoryUrl": "https://github.com/owner/repo",
  "lastCommitSha": "40-char-sha",
  "progressStatus": "complete",
  "currentPosition": "string",
  "completedItems": ["string"],
  "nextActions": ["string"],
  "generationStatus": "succeeded",
  "backupStatus": "succeeded"
}
```

### ProjectDetail

ProjectSummaryに以下を追加する。

```json
{
  "importantDecisions": [
    {
      "decision": "string",
      "rationale": "string",
      "evidence": [
        {
          "id": "uuid",
          "kind": "commit",
          "externalKey": "sha-or-number",
          "title": "string",
          "url": "https://github.com/..."
        }
      ]
    }
  ],
  "allEvidence": [],
  "missingFields": []
}
```

### エラーレスポンス共通形式

```json
{
  "error": {
    "code": "PROJECT_NOT_FOUND",
    "message": "Project not found."
  }
}
```

| ステータス | code | 発生条件 |
|---:|---|---|
| 400 | INVALID_REQUEST | Zod request validation失敗 |
| 404 | PROJECT_NOT_FOUND | project IDなし |
| 409 | PROJECT_ALREADY_REGISTERED | local pathまたはrepo_node_id重複 |
| 409 | RUN_ALREADY_ACTIVE | 同projectのrecovery実行中 |
| 409 | BACKUP_ALREADY_ACTIVE | backup実行中 |
| 422 | NOT_GIT_ROOT | localPathがGit rootでない |
| 422 | GIT_LAYOUT_UNSUPPORTED | linked worktreeまたは`.git`が標準directoryでない |
| 422 | CUSTOM_HOOKS_PATH_UNSUPPORTED | `core.hooksPath`設定済み |
| 422 | REPOSITORY_MISMATCH | originと入力repository不一致 |
| 422 | GITHUB_AUTH_REQUIRED | gh認証なし |
| 422 | HOOK_UNSUPPORTED | 既存hookがshebangなし |
| 422 | NODE_VERSION_UNSUPPORTED | Node.jsが`>=24.15.0 <25`を満たさない |
| 422 | GIT_VERSION_UNSUPPORTED | Gitが`>=2.45.0`を満たさない |
| 422 | GH_VERSION_UNSUPPORTED | ghが`>=2.98.0`を満たさない |
| 422 | CODEX_VERSION_UNSUPPORTED | Codex CLI versionを取得できたが`>=0.146.0`を満たさない |
| 422 | CODEX_VERSION_CHECK_FAILED | `codex --version`を実行できない（spawn失敗 / timeout / 非0終了） |
| 422 | VERSION_PARSE_ERROR | version文字列から`MAJOR.MINOR.PATCH`を抽出できない |
| 422 | CODEX_AUTH_REQUIRED | Codex未ログイン |
| 422 | CODEX_AUTH_CHECK_FAILED | `codex login status`を実行できない（spawn失敗 / timeout） |
| 422 | AI_AUTH_NOT_CHATGPT | CodexがChatGPT認証でない |
| 500 | INTERNAL_ERROR | その他 |

### CLI

```text
node dist/cli/index.js doctor
node dist/cli/index.js hook-commit --project-id <uuid> --repo <path> --sha <sha>
node dist/cli/index.js hook-backup --project-id <uuid> --repo <path> --sha <sha>
node dist/cli/index.js restore
node dist/cli/index.js restore --force
```

- `hook-commit`: 2秒以内にqueue登録とworker spawnを完了してexit 0。
- `hook-backup`: 2秒以内にqueue登録とworker spawnを完了してexit 0。
- `restore`: 既存`tracker.db`がある場合はexit 2。
- `restore --force`: 既存DBを`tracker.db.pre-restore-<timestamp>`へ退避して復元。

---

## 6. 画面・コンポーネント設計

| ID | 名称 | ルート | 状態 | 主要コンポーネント | 対応US |
|---|---|---|---|---|---|
| UI-01 | プロジェクト登録 | `/` | form/validating/error/success | RegisterProjectForm | US-01 |
| UI-02 | プロジェクト進捗ダッシュボード | `/` | loading/ready/empty/error | DashboardPage, ProjectCard, StatusBanner | US-02 |
| UI-03 | プロジェクト詳細 | `/projects/:id` | loading/ready/error | ProjectDetailPage, ProgressSection, EvidenceList, StatusBanner | US-02, US-03, US-05 |

### ルーティング

- client-side router libraryは追加しない。
- `src/web/App.tsx`が`window.location.pathname`を判定し、`/`と`/projects/:id`を描画する。
- Fastifyは`/api/*`以外の`/`と`/projects/*`へ`dist/web/index.html`を返す。

### UI-01 固定入力

- プロジェクト名
- ローカルGit root絶対パス
- GitHub repository `owner/repo`

成功後は同じ画面の一覧へ追加し、初期recovery状態を表示する。

### UI-02 カード表示順

各ProjectCardは以下の順で表示。

1. project名
2. `owner/repo`
3. 最終反映commit短縮SHA（先頭8桁）
4. 現在地
5. 完了事項
6. 次の作業
7. generation status
8. backup status
9. 詳細リンク

`needs_input`のfieldは値を「要補完」と表示する。

### UI-03 判断事項

各判断を以下の順で表示。

1. 判断事項
2. 判断理由
3. 根拠リスト
   - 種別
   - SHA/Issue番号/PR番号
   - タイトル
   - GitHub URL

---

## 7. 横断的関心事

### 認証・認可方式

- Web UI/API:
  - 認証なし。
  - Server bind先を`127.0.0.1`に固定。
  - `Host` headerは`127.0.0.1:<port>`または`localhost:<port>`のみ許可。
  - mutation requestは`Origin`が未指定、または同一originのみ許可。
  - CORS headerは付与しない。
- GitHub:
  - `gh` CLIへ委譲。
  - appはtokenを取得・保存しない。
  - `gh auth token`および`--show-token`は禁止。
- AI:
  - `codex login status`が`Logged in using ChatGPT`の場合だけ実行。
  - `OPENAI_API_KEY`、`OPENAI_ORG_ID`、`OPENAI_PROJECT_ID`はCodex子プロセス環境から除去。
  - API key認証のCodexは拒否。

### エラーハンドリング方針

- UI/API同期処理:
  - known errorを固定codeへ変換。
  - stack traceはUIへ返さない。
- worker:
  - 例外を`generation_runs`または`backup_runs`へ`failed`として保存。
  - `error_message`はredaction後の最大500文字。
- 外部CLI:
  - timeout:
    - git: 10秒
    - gh metadata/list: 20秒
    - Codex generation: 120秒
    - backup git push: 60秒
  - retry:
    - git local command: 0回
    - gh read: 1回、1秒後
    - Codex: 0回。同commitで自動再生成しない。
    - backup push: 1回、2秒後

### ログ出力方針

- level: `info`, `warn`, `error`
- format: JSON Lines
- output: `<TRACKER_DATA_DIR>/logs/app.log`
- rotate:
  - 5 MiBでrotate。
  - 5世代保持。
- 記録するID:
  - project_id
  - generation_run_id
  - backup_run_id
  - commit SHA
  - error_code
- 記録禁止:
  - child process environment全体
  - token
  - password
  - API key
  - `gh auth` raw output
  - `codex login status` raw output
  - AI prompt全文
  - AI raw output全文

### 秘密情報の扱い

以下のキー名をcase-insensitiveでredactionする。

```text
authorization
proxy-authorization
cookie
set-cookie
token
access_token
refresh_token
api_key
apikey
password
secret
OPENAI_API_KEY
GH_TOKEN
GITHUB_TOKEN
ANTHROPIC_API_KEY
```

値は全て`"[REDACTED]"`へ変換。

さらに、DBへ保存するcommit message、commit patch、Issue title/body、PR title/bodyへ以下のhigh-confidence pattern redactionを保存前に適用する。

```text
GitHub classic/fine-grained token: gh[pousr]_* / github_pat_*
OpenAI-style key: sk-*
Anthropic-style key: sk-ant-*
AWS access key ID: AKIA + 16 uppercase alnum
PEM private key block: -----BEGIN ... PRIVATE KEY----- から対応ENDまで
key-value: password|passwd|token|access_token|refresh_token|api_key|apikey|secret|client_secret|access_key に続く値
URL credential/query: user:password@host および上記secret名のquery parameter
```

- replacementは型に関係なく`[REDACTED]`。
- redactionは長さ切り詰めより前に実行する。
- raw文字列をDB、log、backup、AI promptへ渡さない。
- backup export直前にも同じscannerを全export文字列へ実行し、secret-like patternを1件でも検知したらbackupを`failed`、`error_code=SECRET_DETECTED`としてpushしない。

### 環境変数一覧

`.env.example`の中身:

```dotenv
# 非秘密情報のみ。
# 空欄なら ~/.ai-dev-progress-tracker を使用。
TRACKER_DATA_DIR=

# 既定値 4317。1〜65535。
TRACKER_PORT=4317
```

| 変数名 | 必須 | 用途 | 取得方法 |
|---|---|---|---|
| TRACKER_DATA_DIR | No | DB/log/backup clone配置の上書き | ユーザー設定。秘密情報禁止 |
| TRACKER_PORT | No | localhost listen port | ユーザー設定。既定4317 |

`.env.example`へ秘密情報用変数を追加しない。

### Git hook管理ブロック

`post-commit`:

```sh
# AI_DEV_PROGRESS_TRACKER_BEGIN:<project-id>
node "<tracker-root>/dist/cli/index.js" hook-commit \
  --project-id "<project-id>" \
  --repo "$(git rev-parse --show-toplevel)" \
  --sha "$(git rev-parse HEAD)" >/dev/null 2>&1
# AI_DEV_PROGRESS_TRACKER_END:<project-id>
```

`pre-push`:

```sh
# AI_DEV_PROGRESS_TRACKER_BEGIN:<project-id>
node "<tracker-root>/dist/cli/index.js" hook-backup \
  --project-id "<project-id>" \
  --repo "$(git rev-parse --show-toplevel)" \
  --sha "$(git rev-parse HEAD)" >/dev/null 2>&1 || true
# AI_DEV_PROGRESS_TRACKER_END:<project-id>
```

hook scriptが新規の場合は先頭に`#!/bin/sh`を入れる。

### evidence収集範囲

commit runごとに以下だけを収集する。

1. local Git:
   - 対象commitのSHA、parent SHA、author date、message。
   - `git show --format=fuller --stat --patch --no-ext-diff --unified=3 <sha>`
   - patch本文は最大120,000文字。超過時は末尾を切り、`truncated:true`をpayloadへ保存。
2. GitHub Issues:
   - `gh issue list -R owner/repo --state all --limit 20 --json number,title,state,body,updatedAt,url,labels`
   - `updatedAt`降順。
   - bodyは各8,000文字上限。
3. GitHub Pull Requests:
   - `gh pr list -R owner/repo --state all --limit 20 --json number,title,state,body,updatedAt,mergedAt,url,headRefName,baseRefName`
   - `updatedAt`降順。
   - bodyは各8,000文字上限。
4. 既存progress:
   - 対象projectの最新1 snapshotだけ。
5. 他projectのDB行、Git repo、GitHub repositoryは一切入力しない。
6. commit message/patch、Issue/PR title/bodyは「秘密情報の扱い」のscannerを通した**後の文字列だけ**を`evidence.payload_json`へ保存し、AIへ渡す。

### Codex実行コマンド

child processは`spawn`でshellを使わずargv配列で起動する。

```text
codex
  --model gpt-5.6-terra
  --ask-for-approval never
  --sandbox read-only
  exec
  --ephemeral
  --skip-git-repo-check
  --output-schema <absolute-path>/schemas/progress-output.schema.json
  --output-last-message <temp-dir>/progress.json
  -
```

- stdin: 生成prompt。
- cwd: OS temp配下に作る空ディレクトリ。
- promptにはevidence bundleをJSONで埋め込む。
- `OPENAI_API_KEY`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`を子環境から削除。
- exit code 0かつoutput fileがvalid JSONの場合のみ検証へ進む。
- output JSONをDB保存前にZodとevidence参照で再検証。
- valid outputは4 fieldのconfirmed数で分類する:
  - 4: `generation_runs.status=succeeded`, `progress_snapshots.recovery_status=complete`
  - 1〜3: `generation_runs.status=partial`, `progress_snapshots.recovery_status=partial`
  - 0: `generation_runs.status=unrecoverable`, `progress_snapshots.recovery_status=unrecoverable`
- Codex error、timeout、schema不一致、unknown evidence IDは`generation_runs.status=failed`としsnapshotを作らない。
- dashboard/detailが採用するsnapshotは`commits.detected_at DESC, progress_snapshots.created_at DESC`の先頭1件。古いcommitの遅延完了で表示を巻き戻さない。

### AI prompt固定契約

```text
あなたは開発進捗抽出器です。
入力のevidence以外の知識・推測を使わないでください。
4フィールド currentPosition / completedItems / nextActions / importantDecisions を返してください。
根拠が不足するfieldは status=needs_input とし、指定された要補完形式を使ってください。
evidenceIdsには入力bundleに存在するIDだけを使用してください。
判断事項にはdecisionとrationaleを含めてください。
JSON Schemaに完全一致する出力だけを返してください。
```

### バックアップ先

固定:

```text
<gh active user>/ai-dev-progress-tracker-backup
```

要件:

- repositoryが存在しなければ`gh repo create`でPrivate作成。
- 既存の場合はvisibility=`PRIVATE`であること。
- rootの`manifest.json`に`appId: "ai-dev-progress-tracker"`がない既存repositoryは使用拒否。
- default branchは`main`。
- local cloneは`<TRACKER_DATA_DIR>/backup-repo`。
- `gh auth setup-git`を初回ensure時に実行。

### バックアップファイル

```text
backup-repo/
├── manifest.json
└── data/
    └── backup-v1.json
```

`backup-v1.json`はUTF-8、2-space indent、末尾LF。配列はID昇順でsortする。

含めるテーブル:

- projects
- commits
- evidence
- generation_runs
- run_evidence
- progress_snapshots

含めない:

- backup_runs
- worker_leases
- logs
- locks
- 認証情報
- environment
- Codex raw session
- GitHub token

`manifest.json`:

```json
{
  "appId": "ai-dev-progress-tracker",
  "schemaVersion": 1,
  "createdAt": "2026-09-01T00:00:00.000Z",
  "sha256": "<backup-v1.json sha256>",
  "counts": {
    "projects": 0,
    "commits": 0,
    "evidence": 0,
    "generationRuns": 0,
    "runEvidence": 0,
    "progressSnapshots": 0
  }
}
```

### worker lease

SQLiteの`worker_leases`を使う。file lockは使わない。

- generation scope: `generation:<project-id>`
- backup scope: `backup`
- enqueue transaction内で:
  1. `heartbeat_at`が180秒より古いleaseを削除する。
  2. generationのstale lease削除時、そのscopeの`running` runを`failed / WORKER_LEASE_EXPIRED`へ変更する。
  3. scope leaseがなければUUID `owner_token`で作成し、呼出元へ`shouldSpawn=true`を返す。
  4. scope leaseがあればrunだけqueueし、`shouldSpawn=false`を返す。
- workerは30秒ごと、および各外部CLI呼び出し直前・直後にheartbeatを更新する。
- workerはqueued jobを順に処理し、queueが空になった時だけtransaction内で自分の`owner_token`と一致するleaseを削除する。
- queue追加とlease削除はどちらもSQLite write transactionで直列化し、queue取りこぼしを禁止する。
- worker spawnに失敗した場合は作成したleaseを削除し、起点runを`failed / WORKER_SPAWN_FAILED`にする。

### backupとgenerationの同期

- `registration`と`pre_push` backupは`project_id`と`source_commit_sha`を必須で持つ。
- backup workerはexport前に対象`generation:<project-id>:<source_commit_sha>` runがterminal (`succeeded|partial|unrecoverable|failed`)になるまで最大180秒待つ。
- 180秒でterminalにならなければbackup runを`failed / GENERATION_NOT_SETTLED`にし、export/pushしない。
- `manual` backupは全projectの`queued|running` generation runが0件になるまで最大180秒待つ。同条件を満たさなければ`GENERATION_NOT_SETTLED`。
- export内容が前回backupとbyte-identicalなら新しいGit commitを作らず、既存backup HEADを`backup_commit_sha`へ保存して`succeeded`とする。

---

## 8. テスト戦略

| 層 | 対象 | ツール | カバレッジ目標 |
|---|---|---|---:|
| 単体 | schema、redaction、分類、adapter、hook編集、backup export | Vitest 4.1.11 | statements 90%、branches 85% |
| 結合 | SQLite、registration、generation、recovery、backup、restore | Vitest 4.1.11 | 主要USの正常/異常系100% |
| E2E | 登録、dashboard、detail | Playwright 1.62.1 / Chromium | UI-01〜03の主要導線100% |

### 外部依存のテスト方針

CIでは実GitHub/Codexを呼ばない。

- `tests/helpers/fake-gh.ts`
  - argvに応じて固定JSONを返す実行ファイルを一時PATHへ置く。
- `tests/helpers/fake-codex.ts`
  - `codex --version`
  - `codex login status`
  - `codex ... exec`
  を模擬し、schema-valid JSONまたは故意のinvalid JSONを返す。
- `tests/unit/version-check.test.ts`
  - Node: `24.14.9` fail、`24.15.0` pass、`24.99.99` pass、`25.0.0` fail。
  - Git: `2.44.9` fail、`2.45.0` pass、`3.0.0` pass。
  - gh: `2.97.9` fail、`2.98.0` pass、`3.0.0` pass。
  - Codex: `0.145.9` fail、`0.146.0` pass、`0.147.0` pass。
  - parse不能文字列は`VERSION_PARSE_ERROR`。
- 実Codex品質評価は最終手動確認で実行する。

### 必須評価fixture

`tests/fixtures/generation-cases.json`:
- 10ケース。
- 各ケースに`id`, `commitMessage`, `files[{path,content}]`, `expected`を持つ。
- `expected`はfieldごとの`status`, `mustContain[]`, `mustNotContain[]`, `requiredEvidenceExternalKeys[]`を持つ。

`tests/fixtures/recovery-cases.json`:
- 復元可能10ケース。
- 追加で根拠不足ケース4件。
- 各ケースに`id`, `evidence[]`, `expectedRecoveryStatus`, fieldごとの`status`, `mustContain[]`, `mustNotContain[]`, `requiredEvidenceExternalKeys[]`を持つ。

評価時の文字列比較はUnicode NFKC正規化後に英字だけlowercase化し、substring一致で判定する。1ケースは以下を全て満たした時だけpass。

1. expected field statusが一致。
2. 全`mustContain`が対象fieldに存在。
3. 全`mustNotContain`が対象fieldに存在しない。
4. `requiredEvidenceExternalKeys`が生成結果のevidence参照に全て含まれる。
5. unknown evidence IDが0件。

### 非機能テスト

- dashboard:
  - DBへ100 project、各20 snapshotをseed。
  - API取得+Chromium初回描画が2秒以内。
- detail:
  - evidence 100件のprojectで2秒以内。
- startup:
  - test data dirでserver start/stopを10回、10/10成功。
- commit start latency:
  - hook call時刻から`generation_runs.started_at`まで60秒以内。
  - workerテストでは5秒以内を期待値とする。
- silent failure:
  - fake Codex exit 1。
  - invalid JSON。
  - unknown evidence ID。
  - 全件`failed`。
- secret:
  - sentinel secretsをprocess envへ置いて全機能実行。
  - DB/log/exportを走査し0件。

### テスト実行コマンド

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

### CIで走らせる内容

`.github/workflows/ci.yml`:

1. `runs-on: ubuntu-24.04`。
2. `actions/checkout@v7.0.1`。
3. `actions/setup-node@v7.0.0`、`node-version: 24.15.0`、`cache: npm`。
4. `npm install --global npm@12.0.2`。
5. `npm --version`が`12.0.2`と完全一致することを検証。
6. `node -e`で`process.versions.node`が`>=24.15.0 <25`を満たすことを検証。
7. `npm ci`。
8. `npx playwright install --with-deps chromium`。
9. `npm run lint`。
10. `npm run typecheck`。
11. `npm test`。
12. `npm run build`。
13. `npm run test:e2e`。

---

## 9. デプロイ

### 環境一覧

- `local-development`
- `local-production`
- `ci`

外部サーバー環境は作らない。

### 初回セットアップ手順

```bash
git clone <tracker-repository>
cd ai-dev-progress-tracker
npm install --global npm@12.0.2
npm ci
npm run build
npm run cli -- doctor
npm start
```

ブラウザ:

```text
http://127.0.0.1:4317
```

### GitHub認証

事前にユーザー自身が実行する。

```bash
gh auth login
```

アプリはtoken入力欄を持たない。

### Codex認証

事前にユーザー自身が実行する。

```bash
codex --version
# 0.146.0以上であること
codex login
codex login status
```

`Logged in using ChatGPT`以外はMVP標準経路として不許可。

### バックアップ復元

ローカルDB消失時:

```bash
npm ci
npm run build
npm run cli -- restore
npm start
```

既存DBを上書きする明示操作:

```bash
npm run cli -- restore --force
```

### ロールバック手順

アプリコード:

```bash
git checkout <known-good-tag-or-commit>
npm ci
npm run build
npm start
```

DB:

- schema v1のみのためMVP内でdown migrationは作らない。
- restore前の`--force`は既存DBを`tracker.db.pre-restore-<timestamp>`へ退避。
- 問題時はserver停止後、その退避DBを`tracker.db`へ戻す。

---

## 10. 設計判断ログ

| # | 論点 | 決定 | 理由 | 代替案 |
|---:|---|---|---|---|
| D001 | ローカルproject識別 | canonical Git root realpath + GitHub repo node ID + app UUID | 1project 1repoの対応を一意に保つ | — |
| D002 | repository登録 | ユーザー入力`owner/repo`とlocal `origin`を一致検証 | 別repo混入を拒否する | — |
| D003 | progress形式 | JSON Schema v1 + Zod二重検証 | 必須4項目と根拠参照を機械判定する | — |
| D004 | commit検知 | 標準layout repositoryの`.git/hooks/post-commit` | commit成立後を保証契機にする | — |
| D005 | hook処理 | queue登録 + DB lease + detached worker | `git commit`を長時間blockせずqueueを取りこぼさない | — |
| D006 | AI標準経路 | Codex CLI + ChatGPT認証 | 追加API従量課金を標準経路にしない | — |
| D007 | AI認証 | `codex login status`でChatGPT認証だけ許可 | API key課金経路を拒否する | — |
| D008 | GitHub取得 | gh CLI | 認証情報をappへ複製しない | — |
| D009 | push契機 | `pre-push`でbackup enqueue | Git標準hookでpush時処理を起動する | — |
| D010 | push時AI生成 | 実行しない | PLAN F9 WON'Tを維持する | — |
| D011 | backup repository | 専用Private repo固定名 | trackerデータと対象project commitを分離する | — |
| D012 | backup内容 | secret scan済みdeterministic JSON + checksum | DBバイナリ依存なしで検証・復元する | — |
| D013 | recovery分類 | 4/4 complete、1-3/4 partial、0/4 unrecoverable | PLANの成功・部分・不能を機械判定する | — |
| D014 | 根拠不足 | `needs_input` / 「要補完」固定 | 推測の確定保存を防ぐ | — |
| D015 | UI認証 | なし、loopback限定 | 単一ユーザー・ローカルMVPに限定する | — |
| D016 | project削除 | v1ではAPI/UIを実装しない | F1〜F7以外を増やさない | — |
| D017 | timeline | 保存はするが専用時系列UIを作らない | F10 WON'T(v1)を維持する | — |
| D018 | runtime/CLI version policy | Node `>=24.15.0 <25`、Git `>=2.45.0`、gh `>=2.98.0`、Codex `>=0.146.0` | 実機検証差分をv1.1へ反映 | — |
| D019 | 依存install script許可 | npm `12.0.2`が既定でblockするため`package.json`の`allowScripts`で`better-sqlite3`と`esbuild`のみバージョンピン許可 | native/build依存を`npm ci`で動作させつつ許可対象を最小化する | 全script許可（却下: 攻撃面拡大）／native依存を別実装へ差し替え（却下: DESIGN技術選定固定） |
| D020 | better-sqlite3の型定義 | 型定義専用パッケージ`@types/better-sqlite3@9.6.0`を`devDependencies`へ追加 | `better-sqlite3`は型を同梱せず、`strict`前提のtypecheckに型が必須。ランタイム挙動は不変 | 手書きambient宣言（却下: 保守コスト増・不正確）／`any`許容（却下: 規約でany禁止） |
| D021 | Windowsでの外部CLI起動と検査失敗の切り分け | process runnerが`PATH`+`PATHEXT`で実体を解決し、`.cmd`/`.bat` shimは`%ComSpec% /d /s /c`経由で（shellなしで）起動する。Codex検査は「実行不能」を`CODEX_VERSION_CHECK_FAILED`/`CODEX_AUTH_CHECK_FAILED`、「下限未満」を`CODEX_VERSION_UNSUPPORTED`として別コードで返す | Windowsではnpm製CLI（`codex`）が`.cmd` shimで、`spawn(shell:false)`が直接起動できずCVE-2024-27980で拒否される。実行不能と下限未満を同一コードにすると実機での原因切り分けができない | `shell:true`（却下: DESIGNの`shell:false`固定に反する）／実行時にnpm globalの`codex.js`実体を推測（却下: npm版差で壊れやすい）／`cross-spawn`依存追加（却下: 追加npm package最小化方針。相当ロジックを内製） |

---

## 11. 要判断事項（ユーザー確認待ち）

**なし。**

PLAN.md v1.2で設計AIへ委譲された未確定事項は本設計内で全て固定した。
