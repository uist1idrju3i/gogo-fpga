# S14 整列後のE2EとGit情報なしの配布物再生成

[実験の索引](README.md) / [全60組と過去の配布ソース照合](S14-final-regression.md)

## 対象と結果

固定したcommitは `876c2a824e97943fbcd57118494f54f80f9745b9` です。上流・製品用のバイナリーと `web/` は、[07e2256の全60組検証](S14-final-regression.md#整列後の同一revision検証)から変更していません。今回は保存方式へ検査を追従させた後の機能回帰で、設定比較や性能測定ではありません。測定中の版・入力・スクリプトは固定しました。

| 検査 | 実際に確認した結果 |
|---|---|
| 配布前検査だけのE2E | 1件成功。catalog改変・欠落・余剰libraryファイル・bundle改変を拒否 |
| 全体E2E | 76件成功、0件失敗、S5比較専用4件skip |
| Web・Icarusの回帰 | 配布物生成後に178件成功 |
| 依存checker / 配布照合器の単体 | 43件 / 9件成功 |
| Web組立 / package-release | 成功。versionは `v0.1.0-t5.876c2a8` |
| SHA256SUMS | releaseディレクトリーで2件成功 |
| Git情報なしのlibrary再生成 | 22候補・107資材とcatalogが全byte一致 |
| Git情報なしのWeb再生成 | dist全661ファイルの名前・SHA-256が一致 |
| source / Web ZIPの照合 | root 463ファイルとsymlink、35gitlink、source TARの45,233通常ファイル、Web ZIPの695通常ファイルを照合 |

Web ZIPにはdistの661ファイルに加え、README・LICENSE・NOTICEと配布用のライセンス原文31ファイルを加えています。ZIPの695とdistの661は対象範囲が異なります。全distファイルはZIP内でも全byte一致し、全ZIP memberは25 MiB未満でした。catalogのSHA-256は `2df56365ba336356587bd0e611dab5894bca6dd10fb5bf8861f9efbaa6e2d91c` です。

## 実行条件と再実行

ツールの版と製品用native / WASMは[最終回帰の固定条件](S14-final-regression.md#目的と固定条件)を継続しました。GHDL native参照版は同じbinaryを隔離環境で実行し、その互換build rootを `GHDL_WASM_BUILD_ROOT`、起動経路を `GHDL_NATIVE_BIN` へ指定しました。global setupの一時ディレクトリーも共有checkoutの中に置いています。

```sh
TMPDIR="$PWD/build/t5-post-stack-e2e-native-tmp" \
PLAYWRIGHT_PORT=8137 \
S5_PLAYWRIGHT_OUTPUT_DIR=build/t5-post-stack-876c2a8-e2e \
npx playwright test
node --test tests/web/*.test.mjs tests/synth/iverilog-wasm.test.mjs
sh tests/check-pins/run.sh
python3 -m unittest discover -s tests/check-release-closure -p 'test_*.py' -v
scripts/package-release.sh v0.1.0-t5.876c2a8
(cd release && sha256sum --check SHA256SUMS)
```

これらは順次実行しました。同じdistへ組み立てる処理と、その内容を読む検査を並行しません。外部のzstd探索用PATH、GHDLのnative参照用環境変数は、検証済みの固定版に対応させます。

Git情報なしの再生成では、未使用の `build/t5-source-closure-876c2a8/` へsource TARを展開しました。親リポジトリのGitも探索しないよう、`GIT_CEILING_DIRECTORIES` に展開先の親を指定し、`git rev-parse --show-toplevel` の失敗を確認しています。検証済みコンパイラーの出力・SDK・npm依存を再利用してlibraryとWebを組み立てました。全コンパイラーの新規ビルドではありません。

再生成したWebは、元のdistと全ファイル名・全byteのSHA-256を照合しました。続いて以下のCLIで、元のGit snapshot、全archive内容、NOTICE・ライセンス・各tool資材を照合します。出力JSONと再生成先は未使用の場所にします。

```sh
python3 scripts/audit-release-closure.py --root . \
  --source build/t5-source-closure-876c2a8/toolchain-source-v0.1.0-t5.876c2a8 \
  --generated-libraries build/t5-source-closure-876c2a8/generated-libraries \
  --version v0.1.0-t5.876c2a8 --revision 876c2a824e97943fbcd57118494f54f80f9745b9 \
  --output build/t5-source-closure-876c2a8-audit-new.json
```

## 先行した失敗試行と修正

以下の4段落は、全60組の記録から本文を変えずに移動しました。各試行の結果を、後続の成功で置き換えません。

保存API経由へ直した `c56afb2713c9ab764d8ced6f8fa3d0e5e15cbe9f` の全体E2Eは75件成功・1件失敗・4件skipでした。旧OPFS参照による失敗14件は解消しました。残る失敗は配布前検査がT5の `libraries/` を未登録として拒否したもので、固定版22候補を別ディレクトリーへ再生成し、catalogと全107資材を配布物と照合する検査へ修正しました。未使用ファイルの拒否は維持し、catalog改変・欠落・余分なlibraryファイル・bundle改変の負の対照を追加しました。修正後の結果とは別に保持します。

同じc56afb2の依存検査43件、配布ソース照合の単体9件、構文・pin・文書・actionlint検査は成功しました。Web・Icarus検査の初回はE2Eの配布物再生成と重なり、入力manifestがないため1件失敗しました。配布物の組立後は178件すべて成功しました。失敗と再試行のログを分け、並行した組立中の結果を候補の不具合や成功値として扱いません。

全体E2Eの最初の2回は、native GHDLに必要なglibc 2.38がhostにないためglobal setupで停止しました。隔離環境の同じnative binaryへ切り替えた3回目は、検査用の一時ディレクトリーがbind mount外だったため入力を読めず停止しました。4回目は検査の一時ディレクトリーをmount内に置き、全体を完走しています。結果は61件成功・15件失敗・4件skipで、成功へ書き換えません。

失敗14件は、検査器が旧OPFSの個別ファイルを直接読んだためです。schema 3では `workspace.zip` に保存するので、共通の検査helperを `createOpfsStore().load()` 経由へ変更しました。bitstream全byteとSHA-256の比較条件は維持します。残り1件は、配布前検査がbundle化した `project-store.mjs` を未変換の原本と比較したためです。同じesbuild条件で生成した期待値と全byte照合する検査に直しました。配布物や回路の一致条件を緩める修正ではありません。S5測定用helperも同じ保存APIへ追従しましたが、S5 finalist比較測定そのものは未実施です。修正後の全体回帰は、ここに記録した失敗とは別に実施します。

876c2a8の検査をまとめたシェルも、末尾のchecksum確認だけは誤った作業ディレクトリーで実行したため終了値1でした。直前のpackage-releaseは終了値0で成果物を作成しています。正しいreleaseディレクトリーでchecksumをやり直し、2件とも一致しました。全体E2E・単体検査・配布生成の成功と、検査コマンドの作業場所の誤りを区別します。Git探索を禁止した確認での `not a git repository` は意図した負の対照です。

## 証拠のSHA-256

大きなログと検証用のJSONはコミットせず、再実行するコマンドとhashを残します。実測のrevisionは876c2a8であり、後からこの文書を追加したcommitとは区別します。

| 証拠 | SHA-256 |
|---|---|
| c56afb2の全体E2E失敗ログ | `60dd598defdde78a9c12ed3bdc9ef8d31dd95cc2c129f36702330477bb4be6e4` |
| 876c2a8の全体E2E完走ログ | `db0e1678ccbd92c808f3aa41060ecfce42150b9f83be2a985295d4203acebfb1` |
| Git情報なしのWeb全661ファイル監査 | `daa9ed3a90653c9ac0ac6a5e21e6e7b8d0c1d27146fe6029c1b50e39915445c2` |
| source closure監査 | `d0611c54e974c2b420a2981b2c08f1113977e4df4905dbccc1e7136f74c3b010` |
| ソースtar.gz | `729175e580fc533a005efa05a14b3cb5d8908c741b3dc6b7f740b5be85b3c13a` |
| Web ZIP | `1f6984ca9f70dbe39c53b41ae7e4d9aebdf7d917cd58b2d1e02b59bbde4c8108` |

CI、手動の画面操作・録画、T6、S5 finalist比較、S8の残件、Tang Nano実機、Cloudflare Pages公開はこの確認に含みません。既存の自動E2Eの成功を、これらの実施と読み替えません。
