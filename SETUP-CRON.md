# cron-job.org で確実な5分トリガーを設定する

GitHubの定期実行（schedule）は `*/5` を守らない（数十分〜数時間遅延・間引き）。
そこで **cron-job.org（無料・信頼できる外部cron）から5分ごとに、このリポのワークフローを直接叩く**。
GitHubのスケジューラを使わず、実行だけGitHub Actionsに任せる構成。

叩くリクエスト（`workflow_dispatch` API）は検証済み＝204で受理され、runが起動する。

---

## 手順（所要 約3分・1回だけ）

### ① GitHub トークンを1個作る（このリポのActions権限だけの最小スコープ）

1. https://github.com/settings/personal-access-tokens/new を開く（Fine-grained token）
2. **Token name**: `cron-reaction-poll`
3. **Expiration**: お好み（1年 or 無期限）
4. **Resource owner**: `infoniwatama`
5. **Repository access**: **Only select repositories** → `niwatama-reaction-router` を選ぶ
6. **Permissions** → **Repository permissions** → **Actions** を **Read and write** に（Metadataは自動でRead）
7. **Generate token** → 表示された `github_pat_...` をコピー（この画面でしか見えない）

> 万一漏れても、このPublicリポのワークフローを起動/停止できるだけ（Slack/NotionトークンはGH Secretsにあり露出しない）。不安ならいつでもRevokeで即無効化できる。

### ② cron-job.org でジョブを1個作る

1. https://cron-job.org に無料登録 → **Create cronjob**
2. **Title**: `reaction-poll`
3. **URL**:
   ```
   https://api.github.com/repos/infoniwatama/niwatama-reaction-router/actions/workflows/poll.yml/dispatches
   ```
4. **Schedule**: Every 5 minutes（プリセット、または `*/5 * * * *`）
5. **Advanced（またはRequestタブ）** を開く:
   - **Request method**: `POST`
   - **Headers**（3つ追加。`Key: Value` 形式）:
     ```
     Authorization: Bearer github_pat_ここに①のトークン
     Accept: application/vnd.github+json
     X-GitHub-Api-Version: 2022-11-28
     ```
   - **Request body**:
     ```
     {"ref":"master"}
     ```
6. **Save** → 有効化（Enable）

### ③ テスト

- cron-job.org のジョブ画面で **Run now / Test run** を押す
- 結果が **204 No Content** なら成功（GitHub側でrunが起動する）
- 数分待つと、GitHub Actions に `workflow_dispatch` のrunが**自動で5分おきに**並び始める＝完成

---

## 確認コマンド（任意・PCから）

```bash
# 5分おきに workflow_dispatch のrunが自動で増えていればOK
gh run list -R infoniwatama/niwatama-reaction-router --limit 10 \
  --json event,createdAt,conclusion -q '.[]|"\(.event)\t\(.createdAt)\t\(.conclusion)"'
```

## 補足
- ワークフロー内の `schedule:` はそのまま残す（GitHubが気まぐれに発火したら無料のバックアップになる。多重起動は `concurrency` と冪等stateで無害）。
- cron-job.org が主・GitHub schedule が予備、の二重化になる。
- スタンプの反映は「過去5日を毎回走査」なので、トリガーが一度飛んでも次回で必ず拾う（取りこぼしゼロ）。
