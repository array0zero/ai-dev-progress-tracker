# DESIGN.md — 設計書

project_id: ai-dev-progress-tracker  
version: 2.8  
date: 2026-09-04  
source: PLAN.md v1.1 + 公開 `ai-dev-progress-tracker` commit `c281f91` / DESIGN.md v1.7 + 2026-09-02実測環境  
revision 2.2: D006 (Codex notify) を「競合エラー」から「既存notifyを退避してchain」へ変更  
revision 2.3: D027 追加。chain の退避データ検証・TOML認識の範囲検出・atomic write・byte一致復元を固定  
revision 2.4: D028 追加。managed block の構造検証・行頭挿入での往復・`--chain`不正の区別・親終了watchdogを固定  
revision 2.5: D029 追加。block 内 notify の所有権検証・BOM の parse 前除去・watchdog 経路の直接検証を固定  
revision 2.6: D030 追加。managed block の識別・所有権判定を単一関数の 4 条件へ再設計 (4-2 系を置き換え)  
revision 2.7: D031 追加。block 本文を行単位で検証 (コメント等の構造外データを検出) し、dist entry のテストは毎回 build する  
revision 2.8: D032〜D034 追加。実運用障害3件 (backup の secret 誤検知、temp 配下の候補、timeout 未確定) を修正

## 0. 受入検査・実測環境・v1.3〜v1.7互換インベントリ

### 0.1 受入検査

**判定: 合格。**

- US-01〜US-12の全ユーザーストーリーに受け入れ基準がある。
- 非機能要件は、初回表示2.0秒以内、検索・絞り込み0.5秒以内、主要フロー5回連続の異常終了0回、秘密情報保存0件、未登録候補反映率100%、追加固定費0円/月、追加従量課金0円/月、データ自動削除0件として検証可能である。
- F13/F14は既存 `ai-dev-progress-tracker` 実装を物理仕様の唯一の正とする設計ゲートがPLAN.md v1.1で定義され、公開リポジトリを参照できたため詳細設計可能である。

### 0.2 実測環境

| 項目 | 実測値 / 設計上の固定 |
|---|---|
| OS | Windows系PowerShell環境であることを実測。edition/buildは未計測。Windows対応下限は既存v1.3設計を継承して **Windows 11 24H2以降 + Git for Windows** |
| Node.js | `v24.15.0`。製品下限 `>=24.15.0`、上限なし |
| npm | `12.0.2`。製品下限 `>=12.0.2`、上限なし |
| Python | `3.14.5`。製品ランタイム依存にはしない |
| Git | `2.45.1.windows.1`。製品下限 `>=2.45.0`、上限なし |
| GitHub CLI | `2.98.0`。製品下限 `>=2.98.0`、上限なし。`gh auth status` 認証済み |
| Codex CLI | `0.152.0`。製品下限 `>=0.152.0`、上限なし。ChatGPT認証済み |
| Claude Code | `2.1.258`。製品下限 `>=2.1.258`、上限なし。認証状態は未計測のため実機タスクで確認 |
| ブラウザviewport | `2005 x 1271` CSS px。UI密度・性能受入の固定viewport |
| ブラウザ名/version | 未計測。自動E2EはPlaywright同梱Chromium。最終手動受入で実利用ブラウザ名/versionを記録 |

### 0.3 v1.3〜v1.7互換インベントリ

2026-09-02に公開commit `c281f91` を確認し、`DESIGN.md` **v1.7** と実装を互換性の正本として固定する。v1.7は物理JSON Schemaを変更していないが、AI promptと生成出力の受理・正規化、およびrecovery評価条件を更新しているため、これらもF13の「v1.3既存運用を維持」に含める。

| 正本 | v2.0での契約 |
|---|---|
| `schemas/progress-output.schema.json` | **変更禁止**。`schemaVersion=1`、`currentPosition` / `completedItems` / `nextActions` / `importantDecisions` と既存 evidence 契約を維持 |
| `db/migrations/001_init.sql` | **変更禁止**。既存テーブル・制約をv1基盤として維持。v2追加は `002_v2.sql` のみ |
| `src/shared/domain.ts` | 既存status/run/backup型を破壊しない。v2型は追加のみ |
| `src/shared/api.ts` | 既存APIフィールドを削除・rename・意味変更しない。v2フィールドは追加のみ |
| `src/server/services/generation-service.ts` @ `c281f91` | `PROMPT_CONTRACT` のv1.7固定契約を維持する。根拠本文だけでconfirmedを許可し、根拠不足は固定`needs_input`、常にschema-valid JSONを要求し、confirmedは既存evidence IDを必須とする |
| `src/server/schemas/progress.ts` @ `c281f91` | `validateProgressOutput` のv1.7受理規則を維持する。`needs_input`を固定形へ正規化し、不正なdecision itemだけを除去可能とし、unknown evidenceやtop-level schema不一致は失敗させる |
| `scripts/eval-recovery.ts` + `tests/fixtures/recovery-cases.json` @ `c281f91` | default recovery fixtureのexpectedはrecovery status、field status、confirmed fieldのrequired evidenceを正本とする。`mustContain` / `mustNotContain` は任意補助checkとしてのみ残し、default fixtureの必須expectedへ戻さない。unknown evidence 0件も維持する |
| `schemas/backup-v1.schema.json` | **変更禁止**。v1バックアップのrestore入力として永続サポート |
| Private backup構成 | `<gh active user>/ai-dev-progress-tracker-backup`、branch `main`、`.gitattributes`=`* -text`、manifest/checksum方式を維持 |
| `src/server/adapters/process-runner.ts` | Windows `.cmd/.bat` shimを `%ComSpec% /d /s /c`、`shell:false` で起動する既存方式を維持 |
| commit/push hook | `post-commit` は進捗生成、`pre-push` は同期・バックアップのみ |
| AI生成 | Codex CLI + ChatGPT認証 + `gpt-5.6-terra` を維持。Claude Codeを進捗生成backendに追加しない |

### 0.4 v1.7 AI生成・recovery互換契約

v2.0で維持するv1.7の意味契約を以下に固定する。

- confirmed:
  - evidence本文に明示された事実だけを使う。
  - Issue/PRのタイトルだけ、空本文、曖昧/一語の本文、依存更新・lockfile・format等のroutine変更だけでは進捗をconfirmedにしない。
  - fieldおよびitemがconfirmedの場合、当該runに存在するevidence IDを1件以上参照する。
  - `importantDecisions` のconfirmed itemはdecisionとrationaleを両方持つ。
- needs_input canonical form:
  - `currentPosition` → `{"status":"needs_input","text":"要補完","evidenceIds":[]}`
  - `completedItems` / `nextActions` / `importantDecisions` → `{"status":"needs_input","items":[],"evidenceIds":[]}`
  - evidenceが進捗判断に利用できない場合は4fieldすべてneeds_inputを許容し、snapshotを残す。
- output:
  - Codexには拒否文・自由文ではなく、常に`progress-output.schema.json`へ適合するJSONを返すよう要求する。
- `validateProgressOutput`:
  - top-levelのZod/schema shapeが不正なら`CODEX_OUTPUT_INVALID`。
  - status=`needs_input` のfieldに説明文、item、evidence IDが付いていても、schema parse可能な範囲なら上記canonical formへ落として受理する。
  - `importantDecisions.status=confirmed`で、decision/rationaleが空、またはitem-level evidenceが0件のitemは除去する。field-level evidenceが1件以上あれば`items=[]`のconfirmedとして受理可能。
  - available evidenceに存在しないIDをconfirmed field/itemが参照した場合は`UNKNOWN_EVIDENCE_ID`。
  - 正規化はモデルの余計な推測を削除する処理であり、推測内容を確定保存する処理ではない。
- recovery評価:
  - default `recovery-cases.json` のexpectedはexpected recovery status、各field status、confirmed fieldのrequired evidence external keyで固定し、自然言語本文をexpectedへ固定しない。
  - `mustContain` / `mustNotContain` は指定された場合だけ補助checkとして評価可能だが、default fixtureの必須expectedへ再導入しない。
  - unknown evidence ID 0件を維持する。
  - v1.7基準として復元可能10case中8case以上、根拠不足4caseは4/4で`unrecoverable`をrelease regression gateとする。

既存DBの論理リレーション:
- `projects` 1:N `commits`
- `projects` 1:N `evidence`
- `projects` 1:N `generation_runs`
- `generation_runs` N:M `evidence` via `run_evidence`
- `generation_runs` 1:0..1 `progress_snapshots`
- `projects` 1:N `progress_snapshots`
- `projects` 1:N `backup_runs`

v2追加:
- `projects` 1:N `registration_candidates`。candidate登録完了時のみ `project_id` を設定する。
- `registration_candidates.local_path` は一意。同一フォルダのCodex/Claudeイベントは同一candidateへ収束する。

## 1. アーキテクチャ概要

```text
┌────────────── Codex CLI ──────────────┐   ┌──────────── Claude Code ────────────┐
│ ~/.codex/config.toml top-level notify │   │ ~/.claude/settings.json             │
│ first completed turn -> JSON argv     │   │ UserPromptSubmit -> JSON stdin      │
└─────────────────┬─────────────────────┘   └─────────────────┬──────────────────┘
                  │ cwd                                        │ cwd
                  └──────────────────┬───────────────────────────┘
                                     ▼
                        tracker CLI `agent-event`
                    canonicalize cwd / idempotent candidate
                                     │
             ┌───────────────────────┼─────────────────────────┐
             ▼                       ▼                         ▼
      SQLite candidate upsert   local server ensure      browser open
                                                             │
                                                             ▼
┌──────────────── AI Dev Progress Tracker / 127.0.0.1:4317 ───────────────────┐
│ Fastify API + React/Vite UI                                                 │
│  ├─ Dashboard: dense / compact / search / status filter / freshness         │
│  ├─ Registration prompt / unregistered candidates                           │
│  └─ Detail: current state / history / review / regenerate                   │
│                                                                              │
│ SQLite                                                                        │
│  ├─ v1 tables unchanged                                                      │
│  ├─ projects v2 additive columns                                             │
│  └─ registration_candidates                                                  │
│                                                                              │
│ Registration worker                                                          │
│  ├─ git init when required                                                   │
│  ├─ gh repo view/create --private                                            │
│  ├─ origin link                                                               │
│  ├─ local commit -> initial push                                             │
│  └─ initial attempt + exactly 1 retry after 2 sec -> failed candidate        │
│                                                                              │
│ Existing generation worker                                                   │
│  ├─ post-commit -> Codex gpt-5.6-terra -> progress schema v1                 │
│  └─ manual regenerate -> existing recovery pipeline                          │
│                                                                              │
│ Backup/restore                                                               │
│  ├─ pre-push / registration / manual backup                                  │
│  ├─ deterministic backup-v2 + SHA-256 manifest                               │
│  └─ restore schema v1 or v2 into fresh DB, validate, then atomic replace     │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 各構成要素の責務

- **Agent integration installer**
  - `setup-agents` CLIでCodex/Claude Codeのユーザー設定へtracker entryを各1件だけ追加する。
  - Codexの必須検知経路はtop-level `notify`。1 turn完了後に渡されるJSONの`cwd`を使う。
  - Claude Codeの必須検知経路はuser-level `UserPromptSubmit` command hook。JSON stdinの`cwd`を使う。
  - 既存設定を消さずにmergeする。Codexの既存`notify`は退避してchainし、chainできない形のときだけ固定エラーとする。
- **Agent event CLI**
  - event payloadからagent種別・event type・`cwd`だけを使い、会話本文・prompt・transcriptを保存しない。
  - `cwd`がGit配下なら`git rev-parse --show-toplevel`、Git外なら`cwd`をcanonical local pathとする。
  - 既登録pathならno-op。未登録pathならcandidateをupsertする。
  - 初回candidateでlocal serverをensureし、確認URLを既定ブラウザで開く。
- **Registration worker**
  - 承認後のGit初期化、GitHub repository作成/照合、remote、初回push、project登録を単一state machineとして実行する。
  - 初回失敗時だけ2秒後に1回再試行し、2回目失敗後はcandidate=`failed`。
- **Fastify API**
  - UI read/write API、入力検証、localhost境界、candidate/project操作。
  - project一覧取得時にlocal HEADを取り直し、commit差分をDBへ同期して鮮度を算出する。
- **Web UI**
  - `2005x1271`で8件まで1画面比較できるdense listをdefaultにする。
  - M2でcompact viewとkeyword searchを有効化する。
- **Generation worker**
  - v1.3の共通進捗形式に加え、commit `c281f91` / DESIGN v1.7のprompt固定契約と`validateProgressOutput`正規化規則を変更しない。
  - `regenerate`は既存recovery経路へ`manual_recovery`としてqueueする。
  - 根拠不足のreal recoveryでもschema-validな`needs_input` snapshotを残し、軽微な形式揺れだけを理由にrun全体を`CODEX_OUTPUT_INVALID`へ落とさない。
- **Backup/Restore**
  - production writeはbackup schema v2。
  - restoreはv1/v2両方を受け付ける。
  - `unreflected`はderived値なので保存せず、`commits`と`progress_snapshots`から復元後に再計算する。

### Codex user integration 固定仕様

対象: `~/.codex/config.toml` のtop-level `notify`。Codexは`notify`を1件しか持てないため、既存値は削除せずchainする。

1. `smol-toml`で既存TOMLをparseし、文法が壊れていれば無変更で`INVALID_AGENT_CONFIG`。
2. `notify`未設定なら、**fileの先頭 (BOMがあればその直後)** へ `managed block + 改行1つ` を挿入する。
   常に行頭へ入るため末尾改行の有無に依存せず、uninstallは同じ範囲を取り除くだけで
   **元bytesへ完全一致で戻る**。既存文字列・コメント・table順は変更しない
   (top-levelなので「最初のtable headerより前」も満たす)。
3. tracker managed blockが存在しargvが一致すればno-op。
4. 別の`notify`が**string配列**として存在する場合は **chain** する。
   - 既存`notify` assignment の**raw bytes**をbase64化して managed block内の `# previous-notify:` 行へ退避する。
   - 既存 assignment の範囲を managed block へ置換する。file の他の位置は 1 byte も変更しない。
   - tracker argvへ `--chain <既存argvのJSON>` を追加する。
   - 既存argvがstring配列でない場合だけ **`CODEX_NOTIFY_CONFLICT`** とし、無変更で停止する。
4-1. 範囲検出は文字列 (basic / literal / multi-line) と comment を認識して行う。
   `[` `]` `#` を含む値でも誤検出しない。求めた範囲を単独で再parseし、値が元と一致しない場合は
   **範囲不明として無変更で停止**する。
4-2. **managed block の識別と所有権は 1 か所 (`readManagedBlock`) で決める。**
   判定材料は block 自身だけで、file 全体の parse 結果 (top-level `notify` の値) を
   所有権の根拠にしない。次の 4 条件をすべて満たすときだけ「tracker が書いた block」とする。
   1つでも欠ければ `corrupt` とし、install / repair / uninstall のいずれも**書き込みを行わない**。
   doctor も `ready` にしない。
   1. 開始 / 終了 marker が **行全体** として 1 組だけ存在する (marker 行の前後の空白のみ許可、
      marker の後ろに文字列が付く行は marker と認めない)。marker 文字列が block の外にも
      現れる config も対象外。
   2. block の中身が **行単位で** 「`# previous-notify:` 1 行 (任意)」→「`notify` 1 行」の
      順序どおりで、それ以外の行が 1 行も無いこと。TOML parse だけではコメントが結果から
      消えて検出できないため、**行の並びで**判定する。空行・コメント (行末コメントを含む)・
      2 つめの notify があれば tracker の block と認めない。
      notify 行は tracker が書く正準形 `notify = ["...", ...]` と完全一致することまで確認する
      (書式違い・行末コメント付きは正準形と一致しないので弾かれる)。
   3. その `notify` argv が tracker の handler 形であること:
      argv[0] の basename が `node` / `node.exe`、argv[1] が絶対 path の `.../cli/index.js`、
      続く 5 要素が `agent-event --agent codex --input argv`、末尾は無しか
      `--chain <string配列のJSON>` のみ。setup 時点の絶対 path とは比較しないので、
      repository 移動後の `--repair` も所有と認める。
   4. file の top-level `notify` assignment が **この block の範囲内**にあり、値が block の
      `notify` と一致すること (block が table の中にある / 別の場所に top-level notify がある
      構成を弾く)。
4-3. `# previous-notify:` は使用前に必ず検証する。base64の往復一致、TOMLとしてのparse、
   `notify`がstring配列であること、`--chain`のargvと一致することをすべて満たさない場合は
   corrupt。`--chain` は「無い」と「壊れている」を区別し、後者も corrupt。
   「`--chain` も退避も無い」だけが正常な chain なし状態。
4-3-1. `config.toml`への書き込みは temp file への完全書込み → 読み直し検証 → atomic rename で行う。
   途中で失敗しても元 file と退避データを同時に失わない。temp file は必ず後始末する。
4-3-2. 既存 notify を chain するときの置換範囲は **行境界まで広げる**。行末コメントや
   末尾空白も退避に含めるため、marker 行に他の文字が残らず、uninstall が byte 一致で戻せる。
4-4. UTF-8 BOM付きconfigは、**parse前にBOMを本文から切り離す**。以降のoffsetはBOMを除いた
   本文基準で扱い、書き戻すときにBOMを先頭へ復元する。BOMのみ / BOM+top-level値 / BOM+table /
   BOM+既存notify のいずれもinstall・uninstallがbyte一致で往復する。
5. managed blockにはsetup時点の `process.execPath` と `<repo>/dist/cli/index.js` の**絶対パス**を入れる。
6. repository移動後は`doctor`が`AGENT_HOOK_PATH_STALE`を返し、`setup-agents --repair`でtracker managed blockだけ再生成する。退避済み `# previous-notify:` は再生成後も保持する。
7. notifyのJSONは末尾argvとして受け、`type=agent-turn-complete`以外は無視する。
8. handler内部エラーでもCodex本体を失敗させずexit 0。redacted logへerror codeだけ記録する。
9. chain実行の固定順序と分離:
   - handlerは最初に chain 対象を **detached / stdio ignore / unref** で起動し、待たない。
   - 起動引数は「退避したargv + Codexから受け取ったJSON payload」。
   - chain対象のspawn失敗・非0終了・timeoutはtracker側の検知を止めない。
   - tracker側の失敗 (DB/candidate/server/browser) はchain対象の実行を妨げない。
   - `--chain`の値がJSONとしてparseできない場合はchainをskipし、検知だけ続行する。
10. `setup-agents --uninstall` は managed block を削除し、`# previous-notify:` があれば復号した
   **元の raw bytes をそのまま同じ位置へ書き戻す**。退避がなければ block と直後の1改行を削除する。
   いずれの経路でも、install前のfileと**全体byte一致**で戻ることをテストで固定する
   (CRLF / 末尾空白 / 先頭空行 / 末尾改行なし / inline comment を含む)。

```toml
# >>> ai-dev-progress-tracker managed notify >>>
# previous-notify: <base64 of the original raw notify line(s), chain 時のみ>
notify = ["<absolute node executable>", "<absolute dist/cli/index.js>", "agent-event", "--agent", "codex", "--input", "argv", "--chain", "<original argv JSON>"]
# <<< ai-dev-progress-tracker managed notify <<<
```

### Claude Code user integration 固定仕様

対象: `~/.claude/settings.json` の `hooks.UserPromptSubmit`。

1. settingsがなければ新規作成。既存JSONはparseし、未知keyを保持してmergeする。
2. `hooks.UserPromptSubmit`へtracker matcher groupを1件appendする。
3. commandはsetup時点の絶対Node executable、argsは絶対`dist/cli/index.js`, `agent-event`, `--agent`, `claude`, `--input`, `stdin`。
4. 同一entryがあればno-op。他hookは変更しない。
5. `disableAllHooks=true`なら **`CLAUDE_HOOKS_DISABLED`** としてsetup失敗。元settingsは無変更。
6. command timeoutは5秒。handlerはcandidate登録とprompt表示開始だけ行い、GitHub登録/AI生成を行わない。
7. workspace trust完了後の最初の`UserPromptSubmit`で検知する。
8. `claude auth status`はsetup必須条件ではないが、実機タスクでは認証済み実行を確認する。

## 2. 技術選定

lockfileで固定できるnpm依存だけを完全一致固定する。Node/npm/Git/gh/Codex/Claude Codeは最低versionのみ指定し、上限は設定しない。

| レイヤ | 採用技術 | バージョン | 選定理由 | 却下した候補と理由 |
|---|---|---|---|---|
| ランタイム | Node.js | `>=24.15.0` | 既存v1.3実装と実測環境を維持し、server/CLI/workerを単一runtimeで動かせる | Python本体: 全面移植になりv1互換リスク。Bun/Deno: native moduleと既存CLIの再検証が増える |
| package manager | npm | `>=12.0.2` | 実測済みで既存lockfile/allowScripts運用を継続 | pnpm/yarn: lockfileとinstall script許可モデルを変更する |
| VCS CLI | Git | `>=2.45.0` | 既存hook/worktree/remote/push実装を維持 | libgit2等: 新native依存と認証経路を増やす |
| 言語 | TypeScript | `7.0.2` | server/CLI/web/testを既存型システムで増分改修できる | JavaScript:型保証低下。Rust:全面移植 |
| HTTP | Fastify | `5.12.1` | 既存localhost API/static配信を維持 | Express:移行価値なし。Electron IPC:配布/更新範囲が拡大 |
| 静的配信 | `@fastify/static` | `10.1.3` | localhost serverからbuild済みweb assetを配信 | 別web server:常駐processが増える |
| UI | React / react-dom | `19.2.8` / `19.2.8` | 既存componentを増分改修できる | Vue/Svelte:全面移植 |
| Build | Vite / `@vitejs/plugin-react` | `8.2.2` / `6.1.1` | 既存build/E2E構成を維持 | webpack:設定増と移行コスト |
| Data store | SQLite / `better-sqlite3` | `13.0.3` | 1ユーザー/1セッション、ローカル正本、backup exportに適合 | PostgreSQL:daemon/運用費。IndexedDB:CLI/worker共有困難 |
| Validation | Zod | `4.5.4` | 既存API/AI境界を維持 | Ajv全面置換:既存Zod型を壊す |
| TOML parse | `smol-toml` | `1.8.0` | Codex configの既存notifyを構文的に判定できる | regexのみ:TOML誤判定。全体stringify:コメント/format破壊 |
| Lint/format | `@biomejs/biome` | `2.5.11` | 既存CIとLF規約を維持 | ESLint+Prettier:依存/設定増 |
| Unit/Integration | Vitest | `4.1.11` | 既存test資産を再利用 | Jest:移行コストのみ |
| E2E | `@playwright/test` | `1.62.1` | viewport/密度/操作の自動検証に適合 | Cypress:新依存とE2E移植が必要 |
| TS script | `tsx` | `4.23.13` | eval/real-check scriptをTypeScriptで実行 | ts-node:移行価値なし |
| 型 | `@types/node`, `@types/react`, `@types/react-dom`, `@types/better-sqlite3` | `24.13.3`, `19.2.18`, `19.2.5`, `9.6.0` | strict TypeScriptを維持 | 型なし運用:禁止 |
| GitHub連携 | GitHub CLI | `>=2.98.0` | keyring認証を使いtokenをappへ保存せずPrivate repo操作可能 | Octokit+token:credential受渡しが必要 |
| AI生成 | Codex CLI | `>=0.152.0` | 実測ChatGPT認証済みでv1.3生成モデルを維持 | OpenAI API直接:API key/従量課金。Claude生成:生成契約二重化 |
| AI model | Codex `gpt-5.6-terra` | model id固定 | v1.3の既存生成契約 | 別model:fixture/品質再確定が必要 |
| Claude検知 | Claude Code user hook | `>=2.1.258` | `UserPromptSubmit` stdinにcwdがあり追加credential不要 | transcript監視:内部形式依存。filesystem polling:agent開始との因果なし |
| Codex検知 | Codex user `notify` | `>=0.152.0` | turn完了通知のcwdを利用でき、lifecycle hook trustをF1必須前提にしない | lifecycle hookのみ:trust待ち。session監視:private形式 |
| 認証 | Web認証なし + 外部CLI credential store | 外部CLI下限に従う | localhost単独利用、秘密情報0件 | 独自OAuth/token store:不要 |
| Hosting | localhost Fastify | `127.0.0.1:4317` | 常時公開不要、追加費用0円 | cloud hosting:scope外/追加費用 |
| CI | GitHub Actions | repository既存workflow | 既存GitHub運用内で追加サービス不要 | 外部CI SaaS:新契約/費用可能性 |

### npm dependency完全一致

```json
{
  "engines": {
    "node": ">=24.15.0",
    "npm": ">=12.0.2"
  },
  "dependencies": {
    "@fastify/static": "10.1.3",
    "better-sqlite3": "13.0.3",
    "fastify": "5.12.1",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "smol-toml": "1.8.0",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.11",
    "@playwright/test": "1.62.1",
    "@types/better-sqlite3": "9.6.0",
    "@types/node": "24.13.3",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "@vitejs/plugin-react": "6.1.1",
    "tsx": "4.23.13",
    "typescript": "7.0.2",
    "vite": "8.2.2",
    "vitest": "4.1.11"
  },
  "allowScripts": {
    "esbuild@0.28.2": true,
    "better-sqlite3@13.0.3": true
  }
}
```

- `packageManager`の完全一致指定は削除する。
- `.nvmrc`は削除する。Node本体を完全一致固定しない。
- CIは互換下限を検証するためNode `24.15.0`を使うが、製品のNode上限は設定しない。

## 3. ディレクトリ構成

v2.0完成時に許可するリポジトリ構成。実行時生成物 `dist/`, `node_modules/`, `<TRACKER_DATA_DIR>/` は除く。

```text
ai-dev-progress-tracker/
├── .github/
│   └── workflows/
│       └── ci.yml
├── db/
│   └── migrations/
│       ├── 001_init.sql
│       └── 002_v2.sql
├── schemas/
│   ├── backup-v1.schema.json
│   ├── backup-v2.schema.json
│   └── progress-output.schema.json
├── scripts/
│   ├── eval-generation.ts
│   ├── eval-recovery.ts
│   ├── eval-ui-performance.ts
│   ├── real-check-backup-restore.ts
│   ├── real-check-codex-detection.ts
│   ├── real-check-claude-detection.ts
│   ├── real-check-github-registration.ts
│   ├── real-check-regeneration.ts
│   └── verify-no-secrets.ts
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── agent-event.ts
│   │   │   ├── doctor.ts
│   │   │   ├── hook-backup.ts
│   │   │   ├── hook-commit.ts
│   │   │   ├── restore.ts
│   │   │   └── setup-agents.ts
│   │   └── index.ts
│   ├── server/
│   │   ├── adapters/
│   │   │   ├── codex.ts
│   │   │   ├── desktop.ts
│   │   │   ├── git.ts
│   │   │   ├── github.ts
│   │   │   └── process-runner.ts
│   │   ├── db/
│   │   │   ├── backup-repository.ts
│   │   │   ├── candidate-repository.ts
│   │   │   ├── connection.ts
│   │   │   ├── lease-repository.ts
│   │   │   ├── migrations.ts
│   │   │   ├── progress-repository.ts
│   │   │   ├── project-repository.ts
│   │   │   └── run-repository.ts
│   │   ├── routes/
│   │   │   ├── backup.ts
│   │   │   ├── candidates.ts
│   │   │   ├── health.ts
│   │   │   ├── projects.ts
│   │   │   └── system.ts
│   │   ├── schemas/
│   │   │   ├── backup.ts
│   │   │   ├── candidate.ts
│   │   │   ├── progress.ts
│   │   │   └── project.ts
│   │   ├── security/
│   │   │   └── redaction.ts
│   │   ├── services/
│   │   │   ├── agent-integration-service.ts
│   │   │   ├── backup-service.ts
│   │   │   ├── freshness-service.ts
│   │   │   ├── generation-service.ts
│   │   │   ├── hook-service.ts
│   │   │   ├── project-service.ts
│   │   │   ├── recovery-service.ts
│   │   │   ├── registration-service.ts
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
│   │   │   ├── CompactProjectCard.tsx
│   │   │   ├── DashboardToolbar.tsx
│   │   │   ├── DenseProjectRow.tsx
│   │   │   ├── EvidenceList.tsx
│   │   │   ├── ProgressHistory.tsx
│   │   │   ├── ProgressSection.tsx
│   │   │   ├── ProjectCard.tsx
│   │   │   ├── RegisterProjectForm.tsx
│   │   │   ├── RegistrationCandidatePanel.tsx
│   │   │   ├── RegistrationPrompt.tsx
│   │   │   ├── ReviewControls.tsx
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
│       ├── index.ts
│       └── registration-worker.ts
├── tests/
│   ├── e2e/
│   │   ├── dashboard.spec.ts
│   │   ├── project-detail.spec.ts
│   │   └── registration.spec.ts
│   ├── fixtures/
│   │   ├── generation-cases.json
│   │   ├── recovery-cases.json
│   │   ├── ui-performance-observed.json
│   │   └── v1-compat/
│   │       ├── 001_init.sql
│   │       ├── backup-v1.schema.json
│   │       └── progress-output.schema.json
│   ├── helpers/
│   │   ├── fake-codex.ts
│   │   ├── fake-gh.ts
│   │   ├── temp-repo.ts
│   │   └── test-db.ts
│   ├── integration/
│   │   ├── agent-detection.test.ts
│   │   ├── backup-flow.test.ts
│   │   ├── backup-v2.test.ts
│   │   ├── commit-generation.test.ts
│   │   ├── dashboard-freshness.test.ts
│   │   ├── db-migrations.test.ts
│   │   ├── project-registration.test.ts
│   │   ├── registration-retry.test.ts
│   │   ├── recovery-flow.test.ts
│   │   ├── restore-flow.test.ts
│   │   ├── review-regeneration.test.ts
│   │   └── server-shutdown.test.ts
│   └── unit/
│       ├── agent-integration.test.ts
│       ├── backup-export.test.ts
│       ├── candidate-repository.test.ts
│       ├── codex-adapter.test.ts
│       ├── evidence-validation.test.ts
│       ├── freshness.test.ts
│       ├── git-adapter.test.ts
│       ├── github-adapter.test.ts
│       ├── hook-service.test.ts
│       ├── lease-repository.test.ts
│       ├── progress-schema.test.ts
│       ├── recovery-classifier.test.ts
│       ├── redaction.test.ts
│       ├── registration-service.test.ts
│       └── smoke.test.ts
├── .env.example
├── .gitattributes
├── .gitignore
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
├── tsconfig.web.json
├── vite.config.ts
└── vitest.config.ts
```

## 4. データモデル

### エンティティ定義

| エンティティ | フィールド | 型 | 必須 | 制約 | 説明 |
|---|---|---|---|---|---|
| Project | `id` | TEXT UUID | yes | PK | v1維持 |
| Project | `name` | TEXT | yes | 1..120 | 表示名 |
| Project | `local_path` | TEXT | yes | UNIQUE, absolute | canonical local path |
| Project | `repo_node_id` | TEXT | yes | UNIQUE | GitHub immutable node id |
| Project | `repo_owner`,`repo_name`,`repo_url` | TEXT | yes | GitHub repo | v1維持 |
| Project | `default_branch` | TEXT | yes | non-empty | GitHub default branch |
| Project | `status` | TEXT | yes | `active`,`local_missing` | v1維持 |
| Project | `summary` | TEXT | yes | <=240 | v2概要 |
| Project | `registration_source` | TEXT | yes | `manual`,`codex`,`claude` | 登録入口 |
| Project | `review_required` | INTEGER | yes | 0/1 | 要確認 |
| Project | `review_required_at` | TEXT | no | RFC3339 UTC | 要確認設定時刻 |
| RegistrationCandidate | `id` | TEXT UUID | yes | PK | candidate ID |
| RegistrationCandidate | `local_path` | TEXT | yes | UNIQUE absolute | 未登録project root |
| RegistrationCandidate | `agent` | TEXT | yes | `codex`,`claude` | 初回検知agent |
| RegistrationCandidate | `status` | TEXT | yes | state enum | `detected`,`prompted`,`declined`,`registering`,`failed`,`registered` |
| RegistrationCandidate | `suggested_name` | TEXT | yes | 1..120 | folder basename由来 |
| RegistrationCandidate | `detected_at`,`last_seen_at` | TEXT | yes | RFC3339 UTC | 初回/最終event |
| RegistrationCandidate | `prompted_at`,`decision_at` | TEXT | no | RFC3339 UTC | UI提示/判断 |
| RegistrationCandidate | `attempt_count` | INTEGER | yes | 0..2 | registration attempts |
| RegistrationCandidate | `last_error_code` | TEXT | no | <=64 | 最終known error |
| RegistrationCandidate | `last_error_message` | TEXT | no | <=500, redacted | 最終error |
| RegistrationCandidate | `project_id` | TEXT UUID | no | FK projects | registered時のみ |
| Commit | v1列 | existing | existing | `001_init.sql` | HEAD比較 |
| ProgressSnapshot | v1列 | existing | existing | `001_init.sql` | `commit_sha`=生成commit、`created_at`=生成日時 |
| GenerationRun | v1列 | existing | existing | `001_init.sql` | commit/manual recovery |
| BackupRun | v1列 | existing | existing | `001_init.sql` | backup状態 |

### 派生値

- `lastGeneratedCommitSha` = 最新採用`progress_snapshots.commit_sha`。snapshotなし=`null`。
- `lastGeneratedAt` = 同snapshotの`created_at`。snapshotなし=`null`。
- `latestCommitSha` = local repo HEAD。HEADなし=`null`。
- `unreflected`:
  - `latestCommitSha=null` → `false`
  - `latestCommitSha!=null && lastGeneratedCommitSha=null` → `true`
  - 両方あり不一致 → `true`
  - 一致 → `false`
- `hasNextAction` = 最新snapshot `nextActions.status=confirmed` かつ `items.length>0`。
- `lastUpdatedAt` = `max(projects.updated_at, latest commits.detected_at, latest progress_snapshots.created_at, review_required_at)`。backup時刻は含めない。
- snapshotなし:
  - HEADなし: current=`初回コミット待ち`, next=`[]`
  - HEADあり: current=`進捗生成待ち`, next=`[]`
- summary登録時:
  1. GitHub descriptionのtrim結果が非空なら先頭240文字。
  2. なければREADMEの最初のheading以外の非空paragraphを空白正規化して先頭240文字。
  3. なければproject name。

### GitHub repository名正規化

1. Unicode NFKC。
2. trim。
3. ASCII英字をlowercase。
4. whitespace連続を`-`。
5. `[a-z0-9._-]`以外を`-`。
6. `-`連続を1文字へ。
7. 先頭末尾の`.`/`-`除去。
8. 100文字でtruncate後、再度先頭末尾`.`/`-`除去。
9. 空なら `project-<candidate UUID先頭8hex>`。
10. 同ownerに同名repoがありcandidateのoriginと一致しなければsuffix生成せず`REPOSITORY_NAME_CONFLICT`。

### リレーション

- v1リレーションは0.3のまま。
- `projects 1:N registration_candidates`。
- `local_path`はcandidate/projectそれぞれ一意。
- registered candidateも監査/backupのため削除しない。

### 具体スキーマ

`db/migrations/001_init.sql` は既存ファイルを変更しない。

`db/migrations/002_v2.sql`:

```sql
PRAGMA foreign_keys = ON;

ALTER TABLE projects
  ADD COLUMN summary TEXT NOT NULL DEFAULT ''
  CHECK(length(summary) <= 240);

ALTER TABLE projects
  ADD COLUMN registration_source TEXT NOT NULL DEFAULT 'manual'
  CHECK(registration_source IN ('manual', 'codex', 'claude'));

ALTER TABLE projects
  ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0
  CHECK(review_required IN (0, 1));

ALTER TABLE projects
  ADD COLUMN review_required_at TEXT;

UPDATE projects
SET summary = name
WHERE summary = '';

CREATE TABLE registration_candidates (
  id TEXT PRIMARY KEY,
  local_path TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL CHECK(agent IN ('codex', 'claude')),
  status TEXT NOT NULL
    CHECK(status IN ('detected', 'prompted', 'declined', 'registering', 'failed', 'registered')),
  suggested_name TEXT NOT NULL CHECK(length(suggested_name) BETWEEN 1 AND 120),
  detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  prompted_at TEXT,
  decision_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK(attempt_count BETWEEN 0 AND 2),
  last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) <= 64),
  last_error_message TEXT CHECK(last_error_message IS NULL OR length(last_error_message) <= 500),
  project_id TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_registration_candidates_status_seen
  ON registration_candidates(status, last_seen_at DESC);

INSERT INTO schema_migrations(version, applied_at)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
```

Migration invariant:
- v1 DB適用後、既存projectは`summary=name`, `registration_source=manual`, `review_required=0`。
- migration runnerのtransaction内で1回だけ適用し、`schema_migrations.version=2`なら再実行しない。
- migration前にDBを `tracker.db.pre-v2-<UTC timestamp>` へ1 copyし、自動削除しない。

### backup-v2論理schema

`schemas/backup-v1.schema.json`は変更しない。新規`schemas/backup-v2.schema.json`は次のshapeを固定する。

```text
root:
  schemaVersion: const 2
  exportedAt: RFC3339 UTC string
  projects: ProjectBackupV2[]
  commits: v1 CommitBackup[]
  evidence: v1 EvidenceBackup[]
  generationRuns: v1 GenerationRunBackup[]
  runEvidence: v1 RunEvidenceBackup[]
  progressSnapshots: v1 ProgressSnapshotBackup[]
  registrationCandidates: RegistrationCandidateBackupV2[]

ProjectBackupV2:
  v1 project fields
  + summary
  + registrationSource
  + reviewRequired
  + reviewRequiredAt

RegistrationCandidateBackupV2:
  id
  localPath
  agent
  status
  suggestedName
  detectedAt
  lastSeenAt
  promptedAt
  decisionAt
  attemptCount
  lastErrorCode
  lastErrorMessage
  projectId
```

- `backup_runs`, `worker_leases`, logs、agent payload、session/transcript、認証情報はbackupしない。
- production v2 exportは`data/backup-v2.json`をactive manifest対象にする。
- restoreはmanifest `schemaVersion=1`なら`backup-v1.json`、`2`なら`backup-v2.json`。
- v1 restore後にmigration 002を適用。
- `unreflected`は保存せず、restore後にcommit/snapshotから再計算しround-trip一致を検証する。


## 5. インターフェース仕様

### HTTP API

全pathはlocalhost HTTP。同一origin以外のmutationを拒否する。

| メソッド | パス | 認証 | リクエスト | レスポンス | エラー |
|---|---|---|---|---|---|
| GET | `/api/health` | local only | なし | `{status:"ok"}` | 500 |
| GET | `/api/projects` | local only | query `q?`, `states?` | `{projects: ProjectSummaryV2[]}` | 400,500 |
| POST | `/api/projects` | local only | 既存manual register body | `ProjectDetailV2` | 400,409,422,500 |
| GET | `/api/projects/:id` | local only | なし | `ProjectDetailV2` | 404,500 |
| GET | `/api/projects/:id/history` | local only | `limit?` default20/max100, `before?` cursor | `{items,nextCursor}` | 400,404,500 |
| PATCH | `/api/projects/:id/review` | local only | `{required:boolean}` | `{projectId,reviewRequired,reviewRequiredAt}` | 400,404,500 |
| POST | `/api/projects/:id/recover` | local only | 空body | `{runId,status:"queued"}` | 404,409,422,500 |
| POST | `/api/projects/:id/backup` | local only | 空body | `{backupRunId,status:"queued"}` | 404,409,422,500 |
| GET | `/api/candidates` | local only | `status?` | `{candidates: RegistrationCandidate[]}` | 400,500 |
| GET | `/api/candidates/:id` | local only | なし | `RegistrationCandidate` | 404,500 |
| POST | `/api/candidates/:id/approve` | local only | `{name?:string}` | `{candidateId,status:"registering"}` 202 | 400,404,409,500 |
| POST | `/api/candidates/:id/decline` | local only | 空body | `{candidateId,status:"declined"}` | 404,409,500 |
| POST | `/api/candidates/:id/reopen` | local only | 空body | `{candidateId,status:"detected"}` | 404,409,500 |
| GET | `/api/system/status` | local only | なし | version/auth/integration readiness。token/raw auth outputなし | 500 |

### ProjectSummaryV2追加field

```ts
type ProjectSummaryV2 = ProjectSummary & {
  summary: string;
  latestCommitSha: string | null;
  lastGeneratedCommitSha: string | null;
  lastGeneratedAt: string | null;
  lastUpdatedAt: string;
  unreflected: boolean;
  reviewRequired: boolean;
  hasNextAction: boolean;
  registrationSource: "manual" | "codex" | "claude";
};
```

### 検索・絞り込み契約

- search: Unicode NFKC → lowercase → trim → whitespace split。
- 空queryまたはtoken 0件は全project。
- token間はAND。各tokenは次のnormalized textのいずれかへsubstring一致:
  - project name
  - summary
  - `owner/repo`
  - currentPosition text
  - completedItems各text
  - nextActions各text
- state filter:
  - `has_next_action`
  - `needs_review`
  - `unreflected`
- state filter複数選択はOR、search条件とはAND。
- filter/searchは8件中心のproject responseに対してclient-side処理する。

### CLI

```text
node dist/cli/index.js doctor
node dist/cli/index.js setup-agents
node dist/cli/index.js setup-agents --repair
node dist/cli/index.js setup-agents --uninstall
node dist/cli/index.js agent-event --agent codex --input argv <json>
node dist/cli/index.js agent-event --agent claude --input stdin
node dist/cli/index.js hook-commit --project-id <uuid> --repo <path> --sha <sha>
node dist/cli/index.js hook-backup --project-id <uuid> --repo <path> --sha <sha>
node dist/cli/index.js restore
node dist/cli/index.js restore --force
node dist/cli/index.js prune-candidates
node dist/cli/index.js prune-candidates --dry-run
```

`agent-event`:
- Codex: `type=agent-turn-complete`以外はexit 0/no-op。
- Claude: `hook_event_name=UserPromptSubmit`以外はexit 0/no-op。
- `cwd`欠落/relative/non-directoryはredacted warning後exit 0。
- 正常時も5秒以内にexit。GitHub/AI処理を実行しない。
- 除外path (candidateを作らずexit 0):
  - OS temp directory (`os.tmpdir()`) そのものとその配下。実機テストやツールの一時フォルダが
    未登録候補に並ぶため。
  - home directory そのもの、filesystem root。projectではないため。
  - 比較は`path.resolve`後、Windowsはcase-insensitive。境界は`sep`単位で判定し、
    `<temp>-other`のような兄弟pathは除外しない。
  - 実機検知taskと検知テストだけ `TRACKER_ALLOW_TEMP_CANDIDATES=1` (または呼出しoption)で
    この除外を無効化する。production経路では使わない。

`prune-candidates`:
- 既存の誤検出candidateを整理する。対象は`registered`以外で、除外pathか、local pathが存在しないもの。
- `--dry-run`は一覧だけを表示し削除しない。
- `registered` candidateはprojectと紐づくため対象にしない。

### エラーレスポンス共通形式

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "user-safe message"
  }
}
```

| ステータス | code | 発生条件 |
|---:|---|---|
| 400 | `INVALID_REQUEST` | request validation失敗 |
| 404 | `PROJECT_NOT_FOUND` | project idなし |
| 404 | `CANDIDATE_NOT_FOUND` | candidate idなし |
| 409 | `PROJECT_ALREADY_REGISTERED` | local pathまたはrepo node id重複 |
| 409 | `CANDIDATE_ALREADY_DECIDED` | decline/registered等への重複操作 |
| 409 | `RUN_ALREADY_ACTIVE` | recovery実行中 |
| 409 | `BACKUP_ALREADY_ACTIVE` | backup実行中 |
| 409 | `REPOSITORY_NAME_CONFLICT` | 自動repo名が既存別repoと衝突 |
| 422 | `NOT_GIT_ROOT` | manual登録pathがGit rootでない |
| 422 | `GIT_LAYOUT_UNSUPPORTED` | linked worktreeまたは非標準`.git` |
| 422 | `CUSTOM_HOOKS_PATH_UNSUPPORTED` | `core.hooksPath`設定済み |
| 422 | `REPOSITORY_MISMATCH` | originと対象GitHub repo不一致 |
| 422 | `GITHUB_AUTH_REQUIRED` | `gh auth status`失敗 |
| 422 | `HOOK_UNSUPPORTED` | 既存git hookを保持不能 |
| 422 | `CODEX_NOTIFY_CONFLICT` | user configの既存notifyがstring配列でなくchainできない |
| 422 | `CLAUDE_HOOKS_DISABLED` | user settingsでhooks無効 |
| 422 | `AGENT_HOOK_PATH_STALE` | user設定が移動前のtracker絶対pathを参照 |
| 422 | `INVALID_AGENT_CONFIG` | Codex/Claude user configが構文不正 |
| 422 | `NODE_VERSION_UNSUPPORTED` | Node `<24.15.0` |
| 422 | `GIT_VERSION_UNSUPPORTED` | Git `<2.45.0` |
| 422 | `GH_VERSION_UNSUPPORTED` | gh `<2.98.0` |
| 422 | `CODEX_VERSION_UNSUPPORTED` | Codex `<0.152.0` |
| 422 | `CLAUDE_VERSION_UNSUPPORTED` | Claude Code `<2.1.258` |
| 422 | `CODEX_AUTH_REQUIRED` | Codex未login |
| 422 | `CODEX_AUTH_CHECK_FAILED` | Codex auth status取得不能 |
| 422 | `AI_AUTH_NOT_CHATGPT` | CodexがChatGPT認証でない |
| 500 | `GITHUB_REPOSITORY_CREATE_FAILED` | Private repo作成失敗 |
| 500 | `REMOTE_SETUP_FAILED` | origin設定/照合失敗 |
| 500 | `INITIAL_PUSH_FAILED` | commitあり初回push失敗 |
| 500 | `BROWSER_OPEN_FAILED` | 確認URL open失敗。candidate自体は保持 |
| 500 | `INTERNAL_ERROR` | その他 |

## 6. 画面・コンポーネント設計

| ID | 名称 | ルート | 状態 | 主要コンポーネント | 対応US |
|---|---|---|---|---|---|
| S1 | ダッシュボード | `/` | loading/ready/empty/search-empty/error | DashboardPage, DashboardToolbar, DenseProjectRow, CompactProjectCard, StatusBanner | US-04〜09 |
| S2 | 登録確認 | `/?candidate=<uuid>` | detected/registering/failed/registered/declined | RegistrationPrompt | US-01,02 |
| S3 | 未登録候補 | `/` | empty/list | RegistrationCandidatePanel | US-03 |
| S4 | プロジェクト詳細 | `/projects/:id` | loading/ready/error | ProgressSection, ReviewControls, ProgressHistory, EvidenceList | US-08〜10 |
| S5 | 手動登録 | `/` | idle/validating/error/success | RegisterProjectForm | US-03 |

### Dense list固定レイアウト

受入viewport=`2005x1271`。

- page outer padding: 24px。
- header + toolbar +通常時status/candidate collapsed area: `<=190px`。
- dense row: `104px`固定。
- row gap: `8px`。
- 8 rows = 832px、7 gaps=56px、list合計888px。
- `190 + 888 + 48px footer/margin = 1126px` とし1271px内へ収める。
- candidate error panel展開時は8件1画面保証対象外。通常dashboard比較状態を受入対象とする。
- columns:
  1. project name + currentPosition: `42%`
  2. nextActions: `31%`
  3. lastUpdatedAt: `12%`
  4. badges/actions: `15%`
- project name: 16px/600、currentPosition:14px/500。これを最も視覚的に強くする。
- currentPosition/nextActions各2 line clamp。
- badge: `未反映`, `要確認`, `次の作業あり`。
- default sort: `lastUpdatedAt DESC`, tie=`name ASC`。任意sortはv2 scope外。

### Compact view

- width>=1600pxで3 columns。
- card min-height 168px。
- denseと同一ProjectSummaryV2だけを表示。
- view stateは`localStorage["tracker.dashboard.view.v2"]`へ`dense|compact`。
- keyなし/invalidは`dense`。
- view切替によるDB/API mutationは禁止。

### Detail

固定順:
1. `現在の状態` panel。
2. `要確認` / `再生成` controls。
3. visual divider + `進捗履歴` heading。
4. history newest-first、20件単位cursor load。

current/historyは同一DOM sectionへ混在させない。

## 7. 横断的関心事

### 認証・認可方式

- Web:
  - app認証なし。
  - bind `127.0.0.1`のみ。
  - Hostは`127.0.0.1:<port>`または`localhost:<port>`のみ。
  - mutation Originは欠落またはsame-originのみ。
  - CORS headerを付けない。
- GitHub:
  - `gh`既存keyring認証へ委譲。
  - `gh auth token`、token表示optionを禁止。
  - appはtokenを読取/保存しない。
- Codex:
  - `codex login status`がChatGPT loginの場合だけgenerationを許可。
  - child envから`OPENAI_API_KEY`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`を除去。
- Claude:
  - Claude APIは呼ばない。
  - setup/doctorはversionのみ確認。
  - real taskで`claude auth status`を確認し、raw JSONをlog保存しない。
  - `ANTHROPIC_API_KEY`をappへ取込/保存しない。

### 外部CLI timeout/retry

既存Windows process runnerを維持する。

| 操作 | timeout | retry |
|---|---:|---|
| git local read/write | 10s | 0 |
| gh metadata/read | 20s | 1回、1s後 |
| gh repo create | 60s | registration全体retryへ委譲 |
| initial git push | 60s | registration全体retryへ委譲 |
| Codex generation | 120s | 0 |
| backup git push | 60s | 1回、2s後 |
| agent-event local processing | 5s total | 次agent event |
| browser open | 3s | 次agent event |

timeout到達時の停止手順 (`runProcess`):
1. Windowsは`taskkill /pid <pid> /t /f`で **子孫ごと** 停止する。`.cmd` shim経由の起動では
   shimを先にkillすると実体がorphanになり`/t`が辿れないため、shimをkillする前に実行する。
   他OSは`kill()`後に`SIGKILL`。
2. それでも`close`が来ない場合、`KILL_GRACE_MS`(2秒)経過後に`timedOut: true`で強制的に解決する。
   実体が継承したstdout/stderr pipeを握ったままだと`close`が発火しないため、
   timeout値を超えて解決しない状態を作らない。
3. これにより Codex generation は最悪でも `timeout + grace` で terminal になり、
   backup の generation待ち (180秒) を巻き込まない。

registration全体retry:
- attempt1失敗 → redacted error保存 → 2秒待つ。
- attempt2実行。
- attempt2失敗 → `status=failed`, `attempt_count=2`。
- attempt3以降を自動実行しない。
- `reopen`後に再承認された場合だけ`attempt_count=0`へresetし、新しい2-attempt cycleを開始。

### GitHub自動登録state machine

1. canonical path存在確認。
2. Git root判定。Git外なら `git init -b main`。
3. standard `.git` directory / `core.hooksPath`制約を既存manual登録と同じにする。
4. originあり:
   - GitHub URLとしてnormalizeできなければ`REPOSITORY_MISMATCH`。
   - `gh repo view owner/repo --json id,nameWithOwner,url,defaultBranchRef,visibility,description`。
   - 既存repoのvisibilityは変更しない。
5. originなし:
   - `gh auth status`成功確認。
   - `gh api user --jq .login`でowner。
   - 固定repo名正規化。
   - 同名別repoがあれば`REPOSITORY_NAME_CONFLICT`。
   - `gh repo create owner/name --private --source <path> --remote origin`。
   - `gh repo view`再取得でowner/nameと`PRIVATE`を確認。
6. `git rev-parse --verify HEAD`でHEAD有無。
7. HEADありかつ新規GitHub repoの場合だけ `git push -u origin <current branch>`。
8. push後 `git ls-remote origin refs/heads/<branch>` を再取得し、remote SHA=local HEADを完全一致確認。
9. project DB登録、summary算出、existing git hooks設置。
10. HEADありならregistration recoveryをqueue。HEADなしはgenerationなし。
11. registration backupをqueue。
12. candidate=`registered`, `project_id`設定。

### エラーハンドリング

- UIへstack trace/CLI raw stderrを返さない。
- known failureは固定codeへ変換。
- DBの`last_error_message`/run errorはredaction後500文字。
- failed candidateを自動削除しない。
- agent-event内部failureはlog後exit 0。

### ログ

- level: `info`, `warn`, `error`。
- JSON Lines。
- `<TRACKER_DATA_DIR>/logs/app.log`。
- 5 MiBでrotate、5世代。
- project_id, candidate_id, run_id, backup_run_id, commit SHA, error_codeだけを識別子として記録可能。
- 禁止:
  - child process environment全体
  - token/password/API key
  - gh/codex/claude auth raw output
  - agent input message / assistant message / transcript path
  - AI prompt/raw output全文

### 秘密情報

case-insensitive redaction key:
`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `token`, `access_token`,
`refresh_token`, `api_key`, `apikey`, `password`, `secret`, `client_secret`,
`OPENAI_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`。

high-confidence pattern:
- `gh[pousr]_...`, `github_pat_...`
- `sk-...`, `sk-ant-...`
- AWS access key id
- PEM private key
- `password|token|api_key|secret|client_secret`型key-value
- URL userinfo/query credential

backup export の走査 (`scanExportForSecrets`):
- 走査単位は **列の値**。`payload_json` など JSON を持つ列は parse し、string leaf ごとに判定する。
  serialize 済みの文字列を走査すると、改行が `\n` の 2 文字になるため
  `secret:` の直後に `\n[REDACTED]` が続く形が「未 redaction の値」に見え、誤検知する。
- 検出時は `{ table, column, pattern }` だけを返し、値・前後の本文・offset を保持しない。
  `backup_runs.error_message` は
  `A secret-like value was detected in <table>.<column> (pattern: <pattern>); backup was not pushed.`
  とし、秘密情報本文をDB/log/APIへ出さない。
- pattern種別は上記 high-confidence patternの名前 (`github_token` / `aws_access_key_id` /
  `url_credential` / `key_value` など) に限る。

### 環境変数一覧

`.env.example`:

```dotenv
# Optional. Defaults to ~/.ai-dev-progress-tracker
TRACKER_DATA_DIR=

# Optional. Defaults to 4317
TRACKER_PORT=4317
```

| 変数名 | 必須 | 用途 | 取得方法 |
|---|---|---|---|
| `TRACKER_DATA_DIR` | no | DB/log/backup clone path override。test/eval隔離に必須 | ローカルpath |
| `TRACKER_PORT` | no | localhost port。default4317 | 必要時のみ指定 |

credential用envを`.env.example`へ追加しない。

## 8. テスト戦略

| 層 | 対象 | ツール | カバレッジ目標 |
|---|---|---|---|
| 単体 | normalization、freshness、candidate state、redaction、settings merge、schema | Vitest 4.1.11 | statements >=90%, branches >=85% |
| 結合 | SQLite migration、registration、retry、backup/restore、generation queue | Vitest 4.1.11 + temp DB/repo + fake gh/codex | 全体coverage目標に含む |
| E2E | dashboard、registration、filter、toggle、search、detail | Playwright 1.62.1 | PLAN画面受入を全scenario化 |
| 実機 | Codex、Claude、GitHub create/push、Codex regenerate、GitHub backup roundtrip | 専用script | 外部MUST経路を各1回以上成功 |
| 性能 | 8件dashboard、search/filter | Playwright + `eval-ui-performance.ts` | initial<=2.0s、search/filter<=0.5s |

### fakeと実機の分離

- CIはfake gh/codexを使い外部認証を要求しない。
- real scriptsはCIに含めない。
- external service機能はfakeだけで完了扱いにせず、TASKSの専用実機タスクを必須にする。
- 実機script:
  - localはOS temp。
  - GitHubは専用Private fixture repoだけ。
  - Codex/Claude detectionはinvocation-level config/temp settingsでuser agent configを書き換えない。
  - backupは`ai-dev-progress-tracker-backup-e2e-fixture`を使いproduction backup repoを触らない。

### 評価script隔離

- `eval-generation.ts` / `eval-recovery.ts`: 既存detached worktree隔離を維持。
- `eval-recovery.ts`: v1.7のdefault fixture契約（expected recovery status + field status + required evidence + unknown evidence 0件）を維持する。`mustContain` / `mustNotContain`は任意補助checkのままとし、default fixtureの必須expectedへ戻さない。
- recovery release gate: 復元可能10case中8以上、根拠不足4caseは4/4 `unrecoverable`。自然言語本文そのものはexpectedへ固定しない。
- `eval-ui-performance.ts`:
  - `TRACKER_DATA_DIR=<OS temp>`。
  - `TRACKER_PORT=4318`。使用中ならfailし別portを自動選択しない。
  - fixture SQLiteのみ。
  - target repo working tree/DBを書き換えない。
  - viewport=`2005x1271`。
- expected値は想定で書かない。
  - harness作成タスクと、実測して`ui-performance-observed.json`を確定するタスクを分離。
  - thresholdだけPLANの2.0s/0.5sを事前固定する。

### テスト実行コマンド

```text
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run test:e2e
npm run verify:secrets
npm run test:all
```

追加:
```text
npm run setup:agents
npm run real:codex-detection
npm run real:claude-detection
npm run real:github-registration
npm run real:backup-restore
npm run real:regeneration
npm run eval:ui
npm run eval:ui:record
```

### E2E server の終了

- Playwright の `webServer` は npm shim を挟まず `node dist/server/index.js` を直接起動する。
- server は `SIGINT` / `SIGTERM` / `SIGHUP` で listen socket と SQLite handle を閉じて終了する。
- signalが届かない環境でも終わるよう、`TRACKER_PARENT_PID` が指す親プロセスの消滅を
  1秒間隔で監視し、消えていれば同じ経路で終了する (指定が無ければ監視しない)。
- この watchdog 経路は `tests/integration/server-shutdown.test.ts` が直接検証する。
  親を `SIGKILL` で消し (server へは signal を送らない)、server の終了・port解放・
  DB close (再open と data dir 削除が成功すること) を確認する。
  検証は **src (tsx) と build 済み `dist/server/index.js` の両方**で行う (実運用と E2E は dist を
  起動するため)。`test:all` は test → build の順で走るため、dist を対象にするテストは
  **実行前に必ず `npm run build:server` を実行**し、古い artifact を検証しないようにする
  (mtime による鮮度 assert も併せて行う)。
  `TRACKER_PARENT_PID` 未指定では終了しないことも同時に固定する。

### CI

Node `24.15.0`で:
1. `npm ci`
2. `npm run lint`
3. `npm run typecheck`
4. `npm test`
5. `npm run build`
6. `npm run test:e2e`
7. `npm run verify:secrets`

real scriptsはCIへ含めない。

## 9. デプロイ

### 環境一覧

| 環境 | 用途 | DATA_DIR | 外部service |
|---|---|---|---|
| local-dev | 実装 | tempまたはdefault | fake標準 |
| local-real | 実機 | temp | real gh/Codex/Claude + fixture repo |
| local-production | 本人利用 | `~/.ai-dev-progress-tracker` | real gh/Codex、Claudeは検知hook |
| GitHub Actions | CI | temp | fakeのみ |

### 初回セットアップ

```powershell
npm ci
npm run build
npm run cli -- doctor
npm run setup:agents
npm start
```

- `setup-agents`前にbuild必須。user configへ`dist/cli/index.js`絶対pathを記録する。
- Codexに別`notify`があれば削除せずchainする。既存raw行はmanaged block内へ退避し、`--uninstall`で書き戻す。
- 既存notifyがstring配列でなくchainできない形なら`CODEX_NOTIFY_CONFLICT`で停止し無変更。
- Claude `disableAllHooks=true`も無変更で停止。
- setup後`doctor`で`codexDetection=ready`, `claudeDetection=ready`。
- appを移動した場合はbuild後`setup-agents --repair`。

### 通常起動

```powershell
npm start
```

agent-eventがserver未起動なら同じbuildの`dist/server/index.js`をdetached起動し、health成功後に確認URLを開く。

### DB upgrade

- server/CLI起動時にmigration 001→002をtransactionで適用。
- v1 DB変更前に`tracker.db.pre-v2-<UTC timestamp>`を1 copy。
- copyは自動削除しない。

### ロールバック

1. app停止。
2. v2 DBを `tracker.db.v2-failed-<timestamp>`へrename。
3. `tracker.db.pre-v2-<timestamp>`を`tracker.db`へcopy。
4. v1.3 compatible revisionへcheckout。
5. v2 backupをv1 appで読ませない。必要ならGitHub backup historyのv1 manifest commitからrestore。
6. v2 CLI `setup-agents --uninstall`でmanaged Codex notify/Claude hookを除去してからv1へ戻す。

## 10. 設計判断ログ

| # | 論点 | 決定 | 理由 | 代替案 |
|---|---|---|---|---|
| D001 | v1物理仕様 | 公開commit `c281f91`、DESIGN v1.7と同commitの実装ファイルを正本 | 2026-09-02にv1.7が公開され、prompt/validator/evalの実装差分まで参照可能になった | 旧v1.6を正本のまま維持: 却下 |
| D002 | stack | Fastify/React/SQLite/TypeScript継続 | 互換性と最小変更 | 全面刷新: 却下 |
| D003 | runtime/CLI version | minimumのみ | 指示と実測環境に一致 | exact pin/upper bound: 却下 |
| D004 | Codex初回検知 | user top-level `notify` | cwd取得可能、hook trustを必須条件にしない | lifecycle hookのみ: 却下 |
| D005 | Claude初回検知 | user `UserPromptSubmit` hook | 最初のpromptでcwd取得 | SessionEnd/transcript監視: 却下 |
| D006 | Codex notify競合 | 既存notifyを退避してchainする。chainできない形のときだけerror | Codexのnotifyは1件しか持てず、他ツール(Codex computer-use等)が自動設定するため、削除要求は公開リポジトリの前提として不適切。既存argvをmanaged blockへ退避し、`--uninstall`で元のraw行へ復元できるので破壊しない。chain対象はdetachedで起動し待たないため、双方の失敗が相互に伝播しない | 上書き: 却下。利用者へ既存notifyの削除を要求: 却下 (2026-09-02 revision 2.2 でD006を更新) |
| D007 | 未Git project | 承認後`git init -b main` | repoなし/commitなしでも登録完結 | Git必須拒否: 却下 |
| D008 | auto repo名 | fixed normalization、衝突error | agent判断を残さない | suffix自動採番: 却下 |
| D009 | registration retry | total2 attempts、2s | 無限retry回避 | 3回/exponential: 却下 |
| D010 | generation commit/time | existing snapshotを正本 | 重複列不要 | projectsへduplicate: 却下 |
| D011 | 未反映 | local HEADと採用snapshot SHAからderived | restore再現可能 | bool保存: 却下 |
| D012 | 要確認解除 | regenerate成功で自動解除しない | AI正誤を自動保証しない | 自動clear: 却下 |
| D013 | lastUpdatedAt | project/commit/snapshot/reviewのmax | 判断に関係する更新だけ | backup時刻含有: 却下 |
| D014 | dense | 104px row、8件、2005x1271 | 実測viewportで数値的に収める | responsive任せ: 却下 |
| D015 | state filter | client-side、state OR + search AND | 小規模単独利用で単純・高速 | server full-text: 却下 |
| D016 | search | NFKC/lower/AND tokens/substring | 日本語/英数で予測可能 | fuzzy search: 却下 |
| D017 | view state | localStorageだけ | 管理data無変更 | DB保存: 却下 |
| D018 | history | existing snapshots newest-first cursor | 新table不要 | separate audit table: 却下 |
| D019 | AI backend | Codexのみ | v1.3生成契約、追加従量APIなし | Claude生成追加: 却下 |
| D020 | backup | write v2, read v1+v2 | v2復元 + v1互換 | v1 schema変更: 却下 |
| D021 | unreflected backup | 保存しないderived値 | stale状態回避 | bool backup: 却下 |
| D022 | agent payload | cwd/event type以外保存しない | privacy最小化 | transcript保存: 却下 |
| D023 | UI performance | harnessとactual記録を別task | 想定expected禁止 | 事前fixture: 却下 |
| D024 | real external tests | temp local + dedicated Private fixture repo | fake完結防止とuser data保護 | production repo試験: 却下 |
| D025 | exact OS/browser未計測 | implementationをblockせずT025で識別情報だけ記録 | viewportは取得済み、追加質問不要 | 推測記載: 却下 |
| D034 | timeout到達時のprocess停止 | (1) Windowsは shim を kill する前に `taskkill /t /f` で子孫ごと停止する。(2) `close` が来なくても grace 2秒で `timedOut` として強制的に解決する | 実運用で Codex generation が timeout値 120秒ではなく **855秒後** に `CODEX_TIMEOUT` を記録した。`.cmd` shim (cmd.exe) を kill しても実体が生き残り、継承した pipe が閉じないため `close` が発火していなかった。同 generation を待っていた backup が `GENERATION_NOT_SETTLED` になったのも同じ原因。timeout値自体は妥当なので変更しない | timeout値を延ばす: 原因が確定時間ではないため却下。backupのsettle待ち(180秒)を延ばす: 症状の先送りのため却下 (2026-09-04 revision 2.8) |
| D033 | 候補にしないpath | OS temp配下・home directory自身・filesystem rootは candidate を作らない。既存の誤検出は `prune-candidates` で整理する。実機検知taskと検知テストだけ `TRACKER_ALLOW_TEMP_CANDIDATES=1` で除外を無効化する | 実運用で実機テストが作った `…/Temp/adpt-codex-*` が未登録候補に並んだ。これらは消えるフォルダなので登録対象になり得ない。一方 T009/T010 の実機検知は temp projectで検知そのものを確認する必要があるため、production経路に影響しない seam を用意した | UI側で隠す: DBに残り続けるため却下。temp配下を登録時だけ弾く: 候補一覧が汚れたままなので却下 (2026-09-04 revision 2.8) |
| D032 | secret走査の単位と記録内容 | 走査は列の値 (JSON列は parse して string leaf) 単位で行い、検出時は `{table, column, pattern}` だけを error_message へ記録する | 実運用で backup が2回連続 `SECRET_DETECTED` で停止した。原因は evidence.payload_json を **serialize したまま** 走査していたことで、`secret:` の直後の改行が `\n` の2文字になり「既にredaction済み」ガードが外れて誤検知していた。また error_message が固定文言のみで、どの行が原因かを調べられなかった | 走査対象からv2列を外す: 検査の穴になるため却下。検出値の一部を error_message に含める: 秘密情報非保存に反するため却下 (2026-09-04 revision 2.8) |
| D031 | block 本文の行単位検証と dist 鮮度 | (1) block 本文は TOML parse ではなく **行の並び**で検証し、想定外の行 (コメント・空行・行末コメント・2 つめの notify) があれば corrupt。notify 行は正準形と完全一致を要求する。(2) dist entry を検証するテストは毎回 build し、mtime で鮮度も assert する | TOML parse ではコメントが結果から消え、利用者のコメントを「構造外データ」として検出できず uninstall で消していた。また `test:all` は test → build の順なので、古い dist を検証して pass しうる | block 本文を TOML parse だけで検証: 却下。dist の存在確認だけで済ませる: 却下 (2026-09-03 revision 2.7) |
| D030 | managed block 識別の再設計 | marker 検出・構造検証・所有権判定・top-level 一致確認を `readManagedBlock` 1 関数の 4 条件へ統合し、file 全体の parse 結果を所有権の根拠から外す。marker は行全体一致、argv は node 実行体 + 絶対 `.../cli/index.js` + 固定 subcommand + 末尾 `--chain` のみ、chain 置換は行境界まで広げる | 同一領域で 4 回連続して破壊経路が見つかったため、個別の穴埋めをやめ「どこを見て所有と判断するか」を 1 か所へ集約した。所有権の材料が複数箇所に散っていたことが、top-level notify の取り違え・marker 行末の見落とし・argv 先頭の未検証を同時に生んでいた | 個別条件の追加を続ける: 却下。block へ独自 metadata (checksum 等) を持たせる: 追加状態を増やすため却下 (2026-09-03 revision 2.6) |
| D029 | block内notifyの所有権とBOM | (1) 構造検証に加え、block内notify argvの形 (cli/index.js + agent-event + --agent codex + --input argv、末尾は `--chain <json>` のみ) で所有権を判定し、tracker以外ならcorruptとして全mode無変更。判定は内容のみでpath非依存。(2) BOMはparse前に切り離し、書き戻し時に復元する。(3) watchdog経路は親をSIGKILLする専用testで直接検証する | 再々レビューで「正しいmarker対の中に利用者のnotifyがあるconfigをstaleと誤認し、uninstallでそのnotifyが消える」「BOM付きconfigがparse前段で INVALID_AGENT_CONFIG になりBOM対応経路へ到達しない」を実再現。marker構造だけでは所有権を保証できないため、tracker自身のhandlerであることまで確認する方針にした | marker構造だけで所有と見なす: 却下。BOMをそのままparserへ渡す: 却下 (2026-09-03 revision 2.5) |
| D028 | managed block の同定と挿入位置 | (1) blockはmarker対 + 中身の形 (`# previous-notify:` 1行 + `notify` 1行のみ) まで検証し、一致しなければcorruptとして全modeで無変更。(2) notify不在時の挿入はfile先頭固定にして `block + 改行1つ` の往復で byte 一致。(3) `--chain`の「無い」と「不正」を型で区別。(4) E2E serverは signal に加え `TRACKER_PARENT_PID` watchdog で親終了時に自ら終わる | 再レビューで「末尾改行なしconfigへ install すると block が直前行へ連結し復元不能」「利用者コメントがmarkerと一致するとその間の行を削除し重複notifyへ破壊」「不正 `--chain` が corrupt にならず config を書き換える」「sandboxでsignalが届かずE2Eが終了しない」を実再現したため | marker文字列だけで判定: 却下。table header直前へ挿入: 末尾改行なしで往復不能のため却下。signalのみに依存: 環境依存のため却下 (2026-09-03 revision 2.4) |
| D027 | Codex config 書換えの安全性 | (1) 退避base64は往復一致・TOML parse・`--chain`一致まで検証し、不一致なら破壊的操作を行わず`INVALID_AGENT_CONFIG`。(2) notify範囲検出は文字列/commentを認識し、求めた範囲の再parseで自己検証。(3) 書込みは temp file → 検証 → atomic rename。(4) 復元は全体byte一致でテストする | レビューで「破損base64をdoctorがready判定し、uninstallが既存notifyを消す」「argv内の`[`で範囲がずれ`[tui]`以下が消える」「非atomic書込みで元configと退避を同時に失う」「byte-for-byteテストが実際は部分一致だった」を再現。いずれもuser configの破壊につながるため、検出できない限り書かない方針へ統一した | 行分割ベースの範囲検出を維持: 却下。base64を無検証で使う: 却下 (2026-09-03 revision 2.3) |
| D026 | v1.7 recovery互換 | `c281f91`のprompt固定契約、`needs_input`正規化、不正decision item除去、default recovery fixtureのstatus/evidence中心評価をv2互換契約へ追加 | schema自体は不変でも生成受理・品質評価の意味が変わっており、これを落とすと薄いevidenceでsnapshotが消える不具合や自然言語表現揺れによる誤failへ回帰する | schemaだけを互換対象にする: 却下 |

## 11. 要判断事項（ユーザー確認待ち）

**なし。**

OS edition/build、実利用browser名/version、Claude認証状態は未計測だが、いずれも設計方式の分岐条件にしない。TASKSの実機/手動タスクで実測し、最低要件を満たさない場合だけAGENTS.mdの停止条件に従う。
