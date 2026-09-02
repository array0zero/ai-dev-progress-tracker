# AI Dev Progress Tracker

登録済みローカル Git プロジェクトの commit を契機に、Git / GitHub の根拠から Codex CLI で
共通の進捗情報を生成し、localhost の dashboard で「現在地・完了事項・次の作業・重要判断」を
確認する単一ユーザー向け MVP です。

- Web server は `127.0.0.1:4317` だけで listen します。インターネットには公開しません。
- 標準の AI 経路は Codex CLI の **ChatGPT 認証のみ**です。API key 経路は持ちません
  (下記「API key を使わない」を参照)。

設計は `DESIGN.md`、実装タスクは `TASKS.md`、進捗は `PROGRESS.md` を参照してください。

---

## 1. 必要な環境

| ツール | バージョン条件 |
|--------|----------------|
| Node.js | `>=24.15.0` (上限なし) |
| npm | `>=12.0.2` (上限なし) |
| Git | `>=2.45.0` |
| GitHub CLI (`gh`) | `>=2.98.0` |
| Codex CLI | `>=0.152.0` (model `gpt-5.6-terra` / 認証は `Logged in using ChatGPT` のみ) |
| Claude Code | `>=2.1.258` (未登録フォルダ検知の hook のみ。AI 生成には使いません) |

ランタイムと外部 CLI は **下限のみ**を指定し、上限は設けません。
npm パッケージは **範囲指定子 (`^` / `~`) を付けず完全一致で固定**しています
(`package-lock.json` は commit 済み)。

- `dependencies` (7): `@fastify/static` 10.1.3 / `better-sqlite3` 13.0.3 / `fastify` 5.12.1 /
  `react` 19.2.8 / `react-dom` 19.2.8 / `smol-toml` 1.8.0 / `zod` 4.5.4
- `devDependencies` (11): `@biomejs/biome` 2.5.11 / `@playwright/test` 1.62.1 /
  `@types/better-sqlite3` 9.6.0 / `@types/node` 24.13.3 / `@types/react` 19.2.18 /
  `@types/react-dom` 19.2.5 / `@vitejs/plugin-react` 6.1.1 / `tsx` 4.23.13 /
  `typescript` 7.0.2 / `vite` 8.2.2 / `vitest` 4.1.11

GitHub Actions は `actions/checkout@v7.0.1` と `actions/setup-node@v7.0.0` (`node-version: 24.15.0`)
に固定しています。

---

## 2. セットアップ

### 2.1 外部 CLI の認証

`gh` と `codex` は、このアプリを動かすユーザー自身のシェルでログインしておきます。

```bash
gh auth login            # GitHub CLI にログイン (backup 先 private repo の作成/ push に使う)
codex login              # Codex CLI を ChatGPT 認証でログインする
codex login status       # "Logged in using ChatGPT" と表示されることを確認する
```

`codex login status` が ChatGPT 認証でない場合、進捗生成は実行されません。
`OPENAI_API_KEY` を設定していても Codex の子プロセスには渡しません。

### 2.2 依存インストールと健全性チェック

```bash
npm ci                       # 依存を lockfile どおりに入れる
npm run cli -- doctor        # Node / Git / gh / Codex のバージョンと Codex 認証を確認する
```

`doctor` がすべて OK になってから次へ進みます。

### 2.3 ビルドと起動

```bash
npm run build                # server (dist/) と web (dist/web/) をビルドする
npm start                    # http://127.0.0.1:4317 で起動する
```

開発中は `npm run dev` でも起動できます。
ブラウザで `http://127.0.0.1:4317` を開くと dashboard が表示されます。

データ (SQLite / ログ) の保存先は既定で `~/.ai-dev-progress-tracker/` です
(`tracker.db`、`logs/app.log`、`backup-repo/`)。

### 2.4 Codex / Claude Code の検知設定

未登録フォルダを Codex / Claude Code の作業から検知するため、ユーザー設定へ tracker の
エントリを 1 件ずつ入れます。**先に `npm run build` が必要**です (設定には
`dist/cli/index.js` の絶対パスを書き込むため)。

```bash
npm run setup:agents                        # Codex notify + Claude UserPromptSubmit hook を導入
node dist/cli/index.js setup-agents --repair    # リポジトリを移動した後にパスだけ貼り直す
node dist/cli/index.js setup-agents --uninstall # tracker のエントリだけ取り除く
node dist/cli/index.js doctor                   # codexDetection / claudeDetection が ready か確認
```

- **Codex に別の `notify` が既にある場合** (例: Codex computer-use が自動設定するもの) は
  削除しません。既存の値を managed block 内へ退避したうえで **chain** します。
  tracker のハンドラは最初に既存 notify を起動し (結果は待ちません)、そのまま検知を続けます。
  `setup-agents --uninstall` で元の `notify` 行がそのまま書き戻ります。
  既存 `notify` が文字列配列でなく chain できない形のときだけ `CODEX_NOTIFY_CONFLICT` で
  **何も変更せず** 停止します。その場合は既存値を配列形式へ直してから再実行してください。
- **Claude の設定で `disableAllHooks: true` の場合**は `CLAUDE_HOOKS_DISABLED` で停止し、
  `~/.claude/settings.json` を変更しません。hook を有効にしてから再実行してください。
- **`AGENT_HOOK_PATH_STALE`** (リポジトリを移動した / 別の場所へ clone し直した) は
  `setup-agents --repair` で解消します。退避済みの既存 notify は保持されます。
- ハンドラが保存するのは **event 種別と cwd だけ**です。prompt 本文や transcript path は
  保存しません。内部エラーでも Codex / Claude 本体を失敗させません (常に exit 0)。

---

## 3. プロジェクトを登録する

### 3.1 自動登録 (Codex / Claude Code の作業から)

`setup:agents` 済みなら、未登録フォルダで Codex / Claude Code を動かした時点で
登録確認がブラウザで開きます。「登録する」を選ぶと、Git 未初期化なら `git init -b main`、
GitHub repository が無ければ Private で作成して `origin` を張り、commit があれば初回 push まで
行って登録します。失敗した候補は消えず、dashboard の「未登録の候補」からやり直し / 手動登録できます
(自動再試行は 2 秒後に 1 回だけ)。

### 3.2 手動登録

1. `npm start` で起動し、`http://127.0.0.1:4317` を開きます。
2. dashboard 下部の「手動で登録」を開きます。
3. フォームに入力します。
   - **プロジェクト名**: dashboard 上の表示名。
   - **ローカルパス**: Git リポジトリの **ルート** (`.git` があるディレクトリ)。
     linked worktree や `core.hooksPath` 設定済みのリポジトリは未対応です。
   - **リポジトリ**: `owner/repo` 形式。`origin` remote と一致している必要があります。
4. 登録すると `post-commit` / `pre-push` フックが自動で設置され、
   スナップショットが無いため復元用の生成 run が 1 件 enqueue されます。

1 つのプロジェクトに複数の GitHub リポジトリは紐付けできません。

---

## 4. commit 後の進捗生成と push 時 backup

- **commit 時**: `post-commit` フックが `hook-commit` を呼び、対象 commit の生成 run を
  queue に積んで detached worker を spawn します (フック自体は数秒で返ります)。
  生成は非同期で進み、完了すると dashboard のカードに反映されます。
  同一プロジェクト・同一 commit の生成は重複実行しません。push 契機では生成しません。
- **生成結果の分類**: 4 フィールドすべてに根拠があれば `complete`、1〜3 なら `partial`
  (不足フィールドは `要補完`)、0 なら `unrecoverable`。
- **push 時**: `pre-push` フックが backup run を queue に積みます。
  backup は `<gh ログイン名>/ai-dev-progress-tracker-backup` (private) へ、
  6 テーブルを決定的にシリアライズして push します。
  進捗生成が未確定の間は最大 180 秒待ってから実行します。
  DB へ保存する前・backup を push する前に secret scanner を通し、1 件でも検知したら
  push しません。

dashboard 上部には最新の生成失敗 / backup 失敗が warning バナーで表示されます。

---

## 5. backup からの復元

復元は CLI で行います。まず `npm run build` 済みであること。

```bash
npm run cli -- restore           # 既存 DB が無いときだけ復元する。ある場合は exit 2
npm run cli -- restore --force   # 既存 DB を .pre-restore-<timestamp> へ退避してから復元する
```

復元の流れ:

1. `<gh ログイン名>/ai-dev-progress-tracker-backup` を clone / `pull --ff-only`。
2. `manifest.json` の appId / schemaVersion、`data/backup-v1.json` の SHA-256、
   JSON schema、行数を検証。いずれか不一致なら中断 (既存 DB は変更しない)。
3. 一時 DB へ全テーブルを import し、`PRAGMA foreign_key_check` と件数一致を確認。
4. `--force` 時は既存 `tracker.db` を `.pre-restore-<timestamp>` へ rename し、
   検証済み一時 DB を atomic に差し替え。
5. 各プロジェクトについて、ローカルパスが存在すればフックを再設置、
   存在しなければ状態を `local_missing` にする (行は保持)。

### backup / restore の動作確認手順

1. プロジェクトを 1 つ以上登録し、commit → 生成完了を確認する。
2. そのプロジェクトのリポジトリで `git push` し、backup が
   `ai-dev-progress-tracker-backup` に push されることを確認する。
3. `~/.ai-dev-progress-tracker/tracker.db` を退避 (または削除) する。
4. `npm run cli -- restore` を実行し、dashboard で登録済みプロジェクトと進捗が
   復元されることを確認する。

---

## 6. API key を使わない

- 標準の AI 経路は Codex CLI の **ChatGPT 認証のみ**です。
  API key 用の設定・コード経路は追加しません。
- `codex login status` が ChatGPT 認証でない場合は生成を実行しません。
- Codex の子プロセスへ `OPENAI_API_KEY` / `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` /
  `ANTHROPIC_API_KEY` / `GH_TOKEN` / `GITHUB_TOKEN` を渡しません。
- `gh auth token` / `gh auth status --show-token` は呼びません。
- token / password / API key を アプリ DB・設定・ログ・backup へ保存しません。
- Codex / Claude Code の event からは **event 種別と cwd だけ**を使います。
  prompt 本文・assistant message・transcript path・session id は DB にもログにも残しません。

### 使用する外部サービスと費用

| サービス | 用途 | 追加費用 |
|----------|------|----------|
| GitHub (`gh` CLI の既存認証) | Private repository の作成・参照、backup の push/clone | なし (既存アカウント) |
| Codex CLI (既契約の ChatGPT 認証) | 進捗生成 (`gpt-5.6-terra`) | なし (既契約の範囲) |
| Claude Code (既存インストール) | 未登録フォルダの検知 hook のみ。AI 生成には使いません | なし |

- 上記以外の外部サービスは使いません。**追加の固定費 0 円 / 月、追加の従量課金 0 円 / 月**です。
- ネットワーク SaaS の SDK (OpenAI / Anthropic / Octokit / AWS / APM / 解析 / 決済など) を
  依存関係に追加しません。`npm run verify:secrets` がこの条件も検査します。
- アプリはローカルの `127.0.0.1` にのみ bind し、クラウドホスティングを使いません。

---

## 7. 開発コマンド

| コマンド | 用途 |
|----------|------|
| `npm run dev` | 開発サーバー |
| `npm run build` | production ビルド |
| `npm start` | production 起動 |
| `npm test` | unit / integration テスト |
| `npm run test:e2e` | E2E (Playwright / Chromium) |
| `npm run test:all` | lint → typecheck → test → build → E2E |
| `npm run lint` / `npm run typecheck` | Biome / tsc |
| `npm run verify:secrets` | sentinel secret を置いて DB / ログ / backup export を走査し 0 件を確認 |
| `npm run cli -- doctor` | 外部 CLI の版数 / 認証 / 検知設定の health check |
| `npm run setup:agents` | Codex notify + Claude hook の導入 (`--repair` / `--uninstall` は CLI 直呼び) |
| `npm run eval:generation -- --repo <abs-git-root>` | 実 Codex での生成品質評価 (CI では実行しない) |
| `npm run eval:recovery` | 実 Codex での復元品質評価 (CI では実行しない) |
| `npm run eval:ui` / `npm run eval:ui:record` | UI 性能の計測 / 5 run 実測を fixture へ記録 (CI では実行しない) |
| `npm run real:codex-detection` | 実 Codex での未登録フォルダ検知 (temp のみ / CI では実行しない) |
| `npm run real:claude-detection` | 実 Claude Code での未登録フォルダ検知 (temp のみ / CI では実行しない) |
| `npm run real:github-registration` | 実 GitHub での Private repo 作成 / 初回 push (専用 fixture repo のみ) |
| `npm run real:backup-restore` | 実 GitHub での backup-v2 → clone → restore (専用 fixture repo のみ) |
| `npm run real:regeneration` | 実 Codex での再生成と鮮度確認 (temp のみ / CI では実行しない) |

実機スクリプトは CI では実行しません。GitHub を触るものは専用の Private fixture repository
(`ai-dev-progress-tracker-e2e-fixture` / `ai-dev-progress-tracker-backup-e2e-fixture`) だけを使い、
production の backup repository と利用者のプロジェクトは変更しません。

E2E を含む初回は Chromium が必要です:

```bash
npx playwright install --with-deps chromium
```

---

## 8. CI

`.github/workflows/ci.yml` (`ubuntu-24.04`):

1. `actions/checkout@v7.0.1`
2. `actions/setup-node@v7.0.0` (`node-version: 24.15.0`, `cache: npm`)
3. `npm install --global npm@12.0.2`
4. `npm --version` が下限 `>=12.0.2` を満たすことを検証
5. `process.versions.node` が下限 `>=24.15.0` を満たすことを検証
6. `npm ci`
7. `npx playwright install --with-deps chromium`
8. `npm run lint`
9. `npm run typecheck`
10. `npm test`
11. `npm run build`
12. `npm run test:e2e`
13. `npm run verify:secrets`

CI では実 `gh` / 実 `codex` を呼びません (`tests/helpers/fake-gh.ts` /
`tests/helpers/fake-codex.ts` を使用)。
