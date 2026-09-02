# AGENTS.md

## このリポジトリについて

AI Dev Progress Tracker v2.0は、Codex / Claude Codeで開始したローカル開発を半自動登録し、複数projectの現在地・次作業・鮮度を比較する単独利用のlocalhostアプリです。v1.3互換の進捗生成、Private GitHub backup/restore、秘密情報非保存を破壊しないことを最優先とします。

参照すべきファイル:
- `DESIGN.md` — 設計。ここから逸脱しない
- `TASKS.md` — 実装するタスク一覧
- `PROGRESS.md` — 進捗記録（存在しなければ作成する）
- `schemas/progress-output.schema.json` — v1.3共通進捗形式の正本。変更禁止
- `db/migrations/001_init.sql` — v1.3 DB基盤。変更禁止
- `schemas/backup-v1.schema.json` — v1 backup restore契約。変更禁止
- `src/server/services/generation-service.ts` — commit `c281f91` / DESIGN v1.7のAI prompt固定契約を維持
- `src/server/schemas/progress.ts` — v1.7の`validateProgressOutput`正規化・受理契約を維持

Claude Code用に、リポジトリ直下の`CLAUDE.md`をこの`AGENTS.md`とbyte-for-byte同一に保つ。

## 作業の進め方

1. `TASKS.md`をT001から番号順に実行し、依存関係を必ず守る。
2. タスク開始時に`PROGRESS.md`の該当行を`進行中`へ更新する。
3. タスクに列挙されたファイル以外を変更しない。別ファイル変更が必要なら、DESIGN.mdの許可tree内であっても設計変更として停止する。
4. 各タスクの検証コマンドを実行し、すべて通ってからcommitする。
5. commit messageは `T001: <TASKS.mdのタスク名>` の形式にする。
6. commit後に`PROGRESS.md`を`完了`へ更新し、commit SHAと検証結果を記録する。
7. 検証が通らない場合は原因を修正して同じ検証を最大3回行う。3回失敗したら`ブロック`にして停止する。
8. 外部CLI/service依存機能はfakeだけで完了扱いにしない。T009/T010/T011/T017/T018の実機タスクを必ず実行する。
9. eval/benchmarkはDESIGN.md指定の隔離環境だけで実行する。対象repo、`~/.ai-dev-progress-tracker`、production backup repoを評価目的で変更しない。
10. evalのexpected値を想定で作らない。T021でharnessを作り、T022で実出力を確認してからobserved fixtureを生成する。
11. T025以外で人間のUI操作を前提にしない。外部認証不足に到達した場合のみ停止条件に従う。
12. DESIGN.mdと実装の矛盾を見つけたら自分で補完せず停止して報告する。

## PROGRESS.md の形式

```markdown
| タスクID | 状態 | 更新日 | 備考 |
|----------|------|--------|------|
| T001 | 未着手 / 進行中 / 完了 / ブロック | YYYY-MM-DD | 検証結果・commit SHA・実機結果 |
```

初回にT001〜T025を全行作成する。

## 停止する条件（これ以外では停止しない）

- 同一タスクの検証コマンドが3回試しても通らない。
- `DESIGN.md`の技術選定、data schema、interface、directory treeを変更しないと解決できない。
- 利用者の認証が不足し、`gh auth status` / `codex login status` / `claude auth status`が要求状態を満たさない。
- 外部操作が課金開始、新規有料契約、fixture以外のrepository削除/force-pushを要求する。
- Codex user configに既存の別`notify`があり`CODEX_NOTIFY_CONFLICT`になった。
- Claude user settingsが`disableAllHooks=true`で`CLAUDE_HOOKS_DISABLED`になった。
- GitHub実機fixture名と同名の既存repoがあるが、DESIGN.md指定markerがなくfixture所有と確認できない。
- 設計に矛盾があり、両方を同時に満たせない。

上記以外では追加質問をせず、DESIGN.mdの固定ルールに従って進める。

## 守ること

- `schemas/progress-output.schema.json`を変更しない。
- `db/migrations/001_init.sql`を変更しない。
- `schemas/backup-v1.schema.json`を変更しない。
- v1既存API fieldを削除・rename・意味変更しない。
- npm dependency versionをDESIGN.mdと異なる値にしない。`^`/`~`を付けない。
- Node/npm/Git/gh/Codex/Claude Codeへ上限versionを追加しない。
- `latest` / `stable`など未固定のnpm package表現を追加しない。
- `gh auth token`やtoken表示option、credential file読取を実行しない。
- token/password/API keyをDB/config/log/backup/test artifactへ保存しない。
- `OPENAI_API_KEY`や`ANTHROPIC_API_KEY`を生成/検知の標準経路へ導入しない。
- Claude CodeをAI進捗生成backendへ追加しない。AI進捗生成はCodex `gpt-5.6-terra`のみ。
- `git push --force`、fixture以外のrepo delete、production backup repoの評価目的変更をしない。
- 自動登録repo名衝突時にsuffixを勝手に選ばない。
- retryはinitial+1回、間隔2秒から変更しない。
- regenerate成功時に`review_required`を自動解除しない。
- `unreflected`をDB boolとして保存しない。
- v1.7の`PROMPT_CONTRACT`意味要件を削除・弱化しない。
- `validateProgressOutput`をv1.6以前のstrict挙動へ戻し、non-canonical needs_inputだけでrun全体を失効させない。
- default `recovery-cases.json`へ`mustContain` / `mustNotContain`の自然言語期待値を必須として再追加しない。現行v1.7の任意補助check機能自体は削除しない。
- DESIGN.mdのdirectory tree外へファイルを追加しない。
- `TASKS.md`にない機能を追加しない。

## v1.3互換の固定事項

- `progress-output.schema.json`: schemaVersion 1の共通進捗形式をそのまま使用する。
- v1.7 prompt contract: evidence本文だけをconfirmed根拠とし、タイトルのみ/空/曖昧/一語/routine変更のみはneeds_input。4fieldのcanonical needs_input形、schema-valid JSON要求、confirmed evidence参照、decision+rationale要件を維持する。
- v1.7 validator: schema-parse可能なneeds_inputの余分な説明/item/evidenceをcanonical empty形へ正規化する。importantDecisions confirmedの形式不備itemだけを除去し、field-level evidenceがvalidならrun全体を失効させない。unknown evidenceとtop-level schema不一致はrejectする。
- v1.7 recovery eval: default fixtureの必須期待値はrecovery status + field status + required evidence。unknown evidence 0件を維持する。`mustContain` / `mustNotContain`は任意補助checkであり、default fixtureの必須expectedへ戻さない。
- `post-commit`: appがCodex進捗生成を統括する。
- `pre-push`: generationを行わずbackup/syncだけを行う。
- AI: Codex CLI、ChatGPT認証、model `gpt-5.6-terra`。
- SQLite: 001は不変、v2追加は002 migration。
- backup: v1 restoreを永続サポートし、v2 production exportを追加する。
- Windows `.cmd/.bat`起動: existing process-runnerの`%ComSpec% /d /s /c` + `shell:false`方式を維持する。

## 外部service実機タスクの隔離

- T009 Codex detection:
  - OS temp project/dataのみ。
  - invocation-level configを使いuser `~/.codex/config.toml`を変更しない。
- T010 Claude detection:
  - OS temp project/settings/dataのみ。
  - `--restricted -p --settings <temp>`。
  - user `~/.claude/settings.json`を変更しない。
- T011 GitHub registration:
  - `<gh-user>/ai-dev-progress-tracker-e2e-fixture` Privateだけ。
  - marker不一致なら停止する。
- T017 backup:
  - `<gh-user>/ai-dev-progress-tracker-backup-e2e-fixture` Privateだけ。
  - production `<gh-user>/ai-dev-progress-tracker-backup`を試験に使わない。
- T018 regeneration:
  - OS temp git repo/dataだけ。
  - target repositoryをworktree含め変更しない。

## セッション再開時

1. `AGENTS.md`を読む。
2. `DESIGN.md`を読む。
3. `PROGRESS.md`を読む。
4. `TASKS.md`を読む。
5. `git status --short`と`git log -5 --oneline`で状態確認。
6. `進行中`taskがあればそこから。なければ未完了の最小IDから再開。
7. 利用者への確認は不要。停止条件に該当するときだけ報告する。

## コマンド

- セットアップ: `npm ci`
- ビルド: `npm run build`
- 開発サーバー: `npm run dev`
- production server: `npm start`
- CLI doctor: `node dist/cli/index.js doctor`
- agent integration setup: `npm run setup:agents`
- テスト: `npm test`
- 単体: `npm run test:unit`
- 結合: `npm run test:integration`
- E2E: `npm run test:e2e`
- Lint: `npm run lint`
- 型検査: `npm run typecheck`
- 全検証: `npm run test:all`
- secret検査: `npm run verify:secrets`
- Codex実機: `npm run real:codex-detection`
- Claude実機: `npm run real:claude-detection`
- GitHub登録実機: `npm run real:github-registration`
- backup/restore実機: `npm run real:backup-restore`
- regeneration実機: `npm run real:regeneration`
- UI性能: `npm run eval:ui`
- UI性能実測保存: `npm run eval:ui:record`

## コーディング規約

- 命名規則:
  - TypeScript type/class/component: `PascalCase`
  - function/variable: `camelCase`
  - DB column/SQL: `snake_case`
  - REST JSON: `camelCase`
  - file: server/moduleは`kebab-case.ts`、React componentは`PascalCase.tsx`
- ファイル分割:
  - routeはHTTP変換のみ。
  - serviceがuse-case/state machineを持つ。
  - adapterが外部CLI/process境界を持つ。
  - repositoryがSQLだけを持つ。
  - sharedはbrowser/server双方のpure typeのみ。
- コメント:
  - 「何をしているか」の逐語説明は書かない。
  - v1互換、security境界、Windows process起動、state transitionの理由だけを書く。
- 型:
  - `strict`維持。
  - `any`禁止。
  - external JSONは`unknown`からZod/明示validatorでparse。
  - non-null assertion `!`は直前に存在を証明した箇所だけ。
- 時刻:
  - persistence/APIはUTC RFC3339。
  - UIだけlocal timezone表示。
- path:
  - DBにはcanonical absolute path。
  - Windows path比較は`path.resolve`後case-insensitive、その他OSはcase-sensitive。
- error:
  - known failureはDESIGN.mdの固定error code。
  - raw external stderr/stackをAPIへ返さない。
- test:
  - feature task内で実装とtestを同時に完成させる。
  - external writeはreadback equalityを必ずassertする。
