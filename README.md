# 陣取りオンライン ─ 公開手順（itsukik1105-bot/jinpo_online 用）

## 現状

| 項目 | 状態 |
|---|---|
| リポジトリ作成 | ✅ 済み（public） |
| **ファイルの push** | ❌ **未実施（リポジトリが空）** |
| **GitHub Pages 有効化** | ❌ 未実施 |
| 遠隔地どうしのリアルタイム通信 | ✅ アプリ側は実装済み |

**公開されると、このURLになります：**

```
https://itsukik1105-bot.github.io/jinpo_online/
```

---

## Claude Code にそのまま貼り付ける依頼文

index.html があるフォルダで Claude Code を起動して、以下を貼り付けてください。

```
このフォルダの index.html を GitHub Pages で公開したい。

リポジトリ: https://github.com/itsukik1105-bot/jinpo_online
（作成済み・public・現在は空）

やってほしいこと:
1. このフォルダを git 初期化して、上記リポジトリに index.html を push する
   （ブランチ名は main）
2. GitHub Pages を有効化する（Source: main ブランチ / ルート）
3. 公開URLを教えてほしい

補足:
- index.html は単一の静的ファイル。ビルド不要、サーバーサイド処理なし
- サイズが約400KBあるが、通信ライブラリを同梱しているため。正常
- 認証は gh auth login か、必要なら手順を指示してほしい
```

---

## 手動でやる場合

```bash
cd deploy
git init -b main
git add index.html
git commit -m "陣取りオンライン"
git remote add origin https://github.com/itsukik1105-bot/jinpo_online.git
git push -u origin main
```

push後、ブラウザで
`https://github.com/itsukik1105-bot/jinpo_online/settings/pages`
を開き、**Source を「Deploy from a branch」→ Branch を main / (root)** にして Save。

1〜3分後に `https://itsukik1105-bot.github.io/jinpo_online/` が開けるようになります。

---

## 公開できたら、まずこれを確認

1. **自分のPCとスマホ**の両方で上記URLを開く
2. PC側で「部屋を作る」→ 4文字コードが表示される
3. スマホ側で「部屋コードで参加」→ そのコードを入力
4. **両方の画面が配置フェーズに進めば、インターネット越しの疎通は成功**

ここまで通れば、相手が地球の裏側にいても同じように動きます。

---

## 繋がらないときの切り分け

| 症状 | 対処 |
|---|---|
| ページが開けない（404） | Pages の有効化がまだ、または反映待ち。数分待って再読込 |
| 「中継サーバーに接続できませんでした」 | ネットワークが 8084 / 8884 / 8081 番ポートを遮断している可能性。Wi-Fiを切りモバイル回線で試す |
| 部屋は作れるが相手が入れない | 双方リロードして再試行（別ブローカーに繋がった可能性）。コードは 0/O・1/I を含まない文字種です |
| 途中で切断される | 公開ブローカーの混雑。自動再接続します。頻発するなら下記の自前サーバー化を検討 |

**エラーが出たら、その文言をそのまま教えてください。** ブローカーの選定やポートを調整します。

---

## 発展：自前の中継サーバーにする

いまは無料の公開MQTTブローカーを間借りしています。手軽ですが、
**同じ部屋コードを知る第三者が理論上データを覗けます**（友人同士の対戦なら実害はありません）。

気になる場合や安定性を上げたい場合、Claude Code に以下を依頼できます。

```
このアプリの通信部分を、公開MQTTブローカーから自前の中継サーバーに置き換えたい。

- Cloudflare Workers + Durable Objects で WebSocket 中継サーバーを作る（無料枠で足りる）
- 部屋コードごとに Durable Object を1つ割り当て、接続中の全員にブロードキャストする
- index.html 内の Net オブジェクト（MQTT接続部分）だけを WebSocket に差し替える
  ── 送受信する JSON の形式は変えないこと。RULES / UI 側は一切触らない
- 同梱の mqtt ライブラリ（約370KB）は不要になるので削除して軽量化する

デプロイまで済ませて、動作確認の手順を教えてください。
```

これをやると 400KB → 60KB 程度まで軽くなり、通信も自分の管理下に入ります。
ただし Cloudflare のアカウント登録が必要です。
