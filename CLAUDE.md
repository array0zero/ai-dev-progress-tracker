# AGENTS.md

## このリポジトリについて

AI Dev Progress Trackerは、登録済みローカルGitプロジェクトのcommitを契機に、Git/GitHub根拠からCodex CLIで共通進捗を生成し、localhost dashboardで現在地・完了事項・次の作業・重要判断を確認する単一ユーザー向けMVPです。

参照すべきファイル:
- `DESIGN.md` — 設計。ここから逸脱しない
- `TASKS.md` — 実装するタスク一覧
- `PROGRESS.md` — 進捗記録。存在しなければT001開始時に作成する

## 作業の進め方

1. `TASKS.md`をT001から番号順に実行する。依存関係を必ず守る。
2. 1タスクの機能実装と対応テストを同じコミットに含める。
3. 各タスク完了前に、そのタスク記載の検証コマンドをそのまま実行する。
4. 検証が通ったらコミットする。
5. コミットメッセージは`T001: <タスク名>`形式にする。
6. 検証が失敗したら同じタスク内で修正する。
7. 同じ検証失敗を3回修正しても解消できない場合:
   - 次タスクへ進まない。
   - `PROGRESS.md`を`ブロック`へ更新する。
   - 失敗コマンド、exit code、要約したerror、試した修正を記録する。
   - 人間へ報告して停止する。
8. 各タスク完了時に`PROGRESS.md`を更新する。

## PROGRESS.md の形式

```markdown
| タスクID | 状態 | 更新日 | 備考 |
|----------|------|--------|------|
| T001 | 未着手 / 進行中 / 完了 / ブロック | YYYY-MM-DD | |
```

T001開始時にT001〜T020の全行を作成する。

## 守ること

- `DESIGN.md`の技術選定・バージョンを変更しない。
- dependency versionへ`^`または`~`を付けない。
- `packageManager`を`npm@12.0.2`に固定する。
- GitHub Actionsは`actions/checkout@v7.0.1`と`actions/setup-node@v7.0.0`に固定する。
- `package-lock.json`を必ずcommitする。
- `DESIGN.md`のディレクトリ構成に従う。記載されていないファイルを増やさない。
- `TASKS.md`にない機能を追加しない。
- F8〜F14のWON'T(v1)を実装しない。
- 1projectへ複数GitHub repositoryを紐付けない。
- push時にAI generationを実行しない。
- Codex/Claude Codeの作業終了hookを実装しない。
- AI会話全文の取得・同期を実装しない。
- Internet公開用listen addressを追加しない。
- Web serverは`127.0.0.1`以外へbindしない。
- API keyをMVP標準AI経路へ追加しない。
- `codex login status`がChatGPT認証でない場合はgenerationを実行しない。
- `OPENAI_API_KEY`をCodex child processへ渡さない。
- `gh auth token`と`gh auth status --show-token`を呼ばない。
- app DB、設定、log、backupへtoken/password/API keyを保存しない。
- commit patch/message、Issue/PR本文をDB保存する前にDESIGN.mdのsecret scannerを必ず通す。
- backup exportはsecret scannerで1件でも検知したらpushしない。
- child processのenvironment全体をlogへ出さない。
- AI prompt全文とAI raw output全文をlogへ出さない。
- root evidenceがないprogress fieldをconfirmedにしない。
- evidence bundleに存在しないevidence IDを保存しない。
- 他projectのrepository dataを生成inputへ混ぜない。
- 同一project・同一commitのgenerationを重複実行しない。
- 設計に矛盾や不足を見つけたら自分で仕様変更せず、`PROGRESS.md`へ理由を書いて停止する。

## 外部CLI固定条件

- Node.js: `>=24.15.0 <25`
- npm: `12.0.2`
- GitHub CLI: `>=2.98.0`
- Codex CLI: `>=0.146.0`
- Codex model: `gpt-5.6-terra`
- Codex auth: `Logged in using ChatGPT`のみ

CIでは実`gh`/実`codex`を呼ばない。必ず`tests/helpers/fake-gh.ts`と`tests/helpers/fake-codex.ts`を使う。

## コマンド

- セットアップ:

```bash
npm ci
```

- 開発サーバー:

```bash
npm run dev
```

- production build:

```bash
npm run build
```

- production起動:

```bash
npm start
```

- unit/integration test:

```bash
npm test
```

- E2E:

```bash
npm run test:e2e
```

- Lint:

```bash
npm run lint
```

- Typecheck:

```bash
npm run typecheck
```

- 全自動検証:

```bash
npm run test:all
```

- 秘密情報検査:

```bash
npm run verify:secrets
```

- 外部CLI health check:

```bash
npm run cli -- doctor
```

## コーディング規約

- 命名規則:
  - TypeScript変数・関数: `camelCase`
  - class/type/interface/React component: `PascalCase`
  - 定数: `UPPER_SNAKE_CASE`
  - ファイル名:
    - React component: `PascalCase.tsx`
    - その他: `kebab-case.ts`
  - DB column: `snake_case`
  - API JSON: `camelCase`
- ファイル分割の方針:
  - routeはHTTP入出力だけを扱う。
  - business ruleは`services/`。
  - external CLIは`adapters/`。
  - SQL操作は`db/`。
  - schema validationは`schemas/`。
  - Web API typeは`src/shared/`。
- コメントの方針:
  - 実装から明白なコメントは書かない。
  - Git hook編集、backup atomicity、secret redaction、recovery判定の不変条件だけコメントする。
  - TODOを残さない。未実装はタスク未完了として扱う。
- 型の扱い:
  - `any`禁止。
  - external inputは全てZod parse後に使用する。
  - `unknown`はtype guard/Zodで絞る。
  - non-null assertion `!`はDOM root取得以外禁止。
  - DB row→domain model変換関数を必ず通す。
- error:
  - raw child-process stderrをUIへ返さない。
  - API error codeはDESIGN.mdの固定一覧を使う。
  - secret redaction前の文字列を永続化しない。
- 時刻:
  - DB保存はUTC ISO-8601。
  - UI表示のみlocal timezoneへ変換する。
- ID:
  - app entity IDは`crypto.randomUUID()`。
  - Git SHAやGitHub node IDをapp UUID代用にしない。
