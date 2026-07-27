# niwatama-reaction-router (polling)

Slackの `#yt_editor` でスタンプを押すと Notion「タスク管理ツール」に反映する。
**GitHub Actionsで5分ごとに巡回**するので、このPCが起動していなくても動く（クラウド実行・無料枠）。

## スタンプ→アクション
| スタンプ | メッセージ | 反映 |
|---|---|---|
| `:kakunin:` | ver1メッセージ | ステータス→確認待ち（URLあれば修正前URL） |
| `:kanryou:` | 納品(URL)メッセージ | 完パケURL＋ ロング→サムネ待ち／非ロング→投稿待ち |
| `:samune:` | 画像メッセージ | サムネ添付、サムネ待ちなら→投稿待ち |
| `:sumi:` | スレッドのどれか | ステータス→投稿済み |

処理したメッセージには bot が 🤖`:robot_face:` を付け、スレッドに結果を返信する。

## 冪等性（重要）
5分ごとに再スキャンするため、**処理済み(メッセージts:絵文字)を `state/processed.json` に記録**し、GH Actionsがコミットバックする。
→ 同じリアクションを二度処理しない＝一度進めた状態を巻き戻さない。

## セットアップ（済み）
- GH Secrets: `SLACK_BOT_TOKEN` / `NOTION_TOKEN`
- Actions: `.github/workflows/poll.yml`（cron `*/5`・手動実行 `workflow_dispatch` 可）

## ローカル実行
```
SLACK_BOT_TOKEN=xoxb-... NOTION_TOKEN=ntn_... node poll.js        # dry-run（表示のみ）
SLACK_BOT_TOKEN=xoxb-... NOTION_TOKEN=ntn_... node poll.js --apply # 反映＋state更新
```
（ローカルは env 未指定なら `~/.claude.json` と `~/dept-orchestrator/.env` からフォールバック取得）

## 旧: リアルタイム版（PC常駐）
`~/dept-orchestrator/reaction-router.js`（Socket Mode・PC起動中のみ）。本ポーリング版が動けばそちらは不要。
両方同時に動かすと二重処理の恐れ→**どちらか一方**にする。
