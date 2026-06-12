# rim-inm-drive

Windowsのローカルフォルダと、`rimworld-inm` の `/share-cloud-drive` ルートを30秒間隔で双方向同期するクライアントです。

## 使用方法

1. `dist/rim-inm-drive.exe` を起動します。
2. 初回のみ、サーバーURL、同期先フォルダ、アカウント情報を入力します。
3. 設定後は同期フォルダがExplorerで開き、バックグラウンドで30秒ごとに同期します。

再設定する場合:

```powershell
.\dist\rim-inm-drive.exe --setup
```

## ビルド

```powershell
npm install
npm run build
```

同期API・認証・DBマイグレーションなどのサーバー側実装は、`rimworld-inm` リポジトリで管理します。

競合時は、ローカル版を `(conflict ...)` 付きの名前で保持してからサーバー版を取得します。
