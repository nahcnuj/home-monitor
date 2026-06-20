# home-monitor

自宅回線の DNS 応答レイテンシを監視し、GitHub Pages で可視化するツールです。

## 仕組み

1. **Windows PC** — 1分ごとに `nslookup` を実行し、レイテンシをローカル TSV に記録
2. **6時間ごと** — `gh workflow run` で未送信データをワークフローへ送信
3. **GitHub Actions** — 受信データを `docs/data/dns-latency.tsv` にマージし、Pages をデプロイ
4. **ダッシュボード** — `https://nahcnuj.github.io/home-monitor/` でグラフ表示

## セットアップ

### 1. GitHub リポジトリ

```powershell
git remote add origin https://github.com/nahcnuj/home-monitor.git
git push -u origin master
```

GitHub の **Settings → Pages → Build and deployment → GitHub Actions** を有効化してください。

### 2. GitHub CLI

[GitHub CLI](https://cli.github.com/) をインストールし、認証:

```powershell
gh auth login
```

### 3. タスクスケジューラ登録

管理者 PowerShell で実行:

```powershell
cd C:\Users\nahcnuj\ghq\github.com\nahcnuj\home-monitor
.\scripts\install-scheduled-task.ps1
```

| タスク名 | 間隔 | 内容 |
|----------|------|------|
| `HomeMonitor-DNS-Collect` | 1分 | nslookup 計測 |
| `HomeMonitor-DNS-Publish` | 6時間 | GitHub へデータ送信 |

### 4. 動作確認

```powershell
# 計測テスト
.\scripts\collect-dns.ps1

# 送信テスト（gh auth login 後）
.\scripts\publish-data.ps1
```

GitHub の Actions タブで **Sync DNS Data** ワークフローが起動することを確認してください。

## データ形式 (TSV)

成功:

```
1718863200	google.com	42
```

失敗:

```
1718863260	google.com		timeout
```

## 設定

[`config/monitor.json`](config/monitor.json) でクエリ先ドメインのみ変更できます。それ以外（間隔・タイムアウト・保持期間など）は固定です。

## ファイル構成

```
config/monitor.json       設定
scripts/collect-dns.ps1   計測スクリプト
scripts/publish-data.ps1  データ送信
scripts/install-scheduled-task.ps1  タスク登録
docs/                     GitHub Pages ダッシュボード
data/local/               ローカルデータ (gitignore)
```