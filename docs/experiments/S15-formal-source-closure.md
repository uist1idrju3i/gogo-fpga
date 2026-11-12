# S15 P0: 形式検証の配布ソース照合

[実験一覧](README.md) / [形式検証の事前基準](S15-formal-verification.md) / [ソースと依存の調査](../research/formal-sources.md)

## 目的と固定条件

形式検証を実行する前に、採用した6ソース、GMPの原archive、licenseとNOTICEが、固定commitから配布物まで追えることを確かめます。対象は `c41e5c53d99eff9c604ffe8dec274e49f0189a61` です。この記録を追加する後続commitとは区別します。

実施日は2026-11-01 UTCです。6ソースの固定値とGMPのURL・hashは、対象commitのRESEARCHを正とします。Web組立には同じgitlinkのzstd 1.5.7を使いました。既に検証したWASM、SDK、npm依存を再利用しており、コンパイラーや形式検証ソルバーはこの確認で再ビルドしていません。

事前条件は、固定ソースと全licenseの保持、archive hash・manifestの一致、Gitのない配布ソースからの再生成、Web ZIPと配布ソースの全file照合です。機械的な配布検査であり、画面目視や形式検証の5回反復の代わりにはしません。

## 結果

| 検査 | 結果 |
|---|---|
| pin consistency | 成功。6ソースのgitlink・完全長SHA・版・URL・license・NOTICEを含む |
| pinとGMP取得処理の単体検査 | 53件成功。旧43件に形式ソース・archiveの10件を追加 |
| 配布照合器の単体検査 | 9件成功 |
| 文書パス・サイズ検査の単体検査 | 20件・25件成功 |
| JIS・リンク・文書サイズ・個人パス | エラー0。既存スキルの文字警告2件、文書サイズの検討警告8件は保持 |
| Python compile・shellcheck・diff | 成功。Python3ファイルと変更したshellを対象 |
| yomiyasu | 変更した8文書を個別に検査。エラー0、推敲候補は文脈で確認 |
| 配布物の組立とSHA256SUMS | Web ZIPとsource tar.gzが成功 |
| Gitなしのlibrary再生成 | 全22候補・107資材が元のcatalog・配布物と一致 |
| GitなしのWeb再組立 | 全661fileのSHA-256が元のdistと一致 |
| source closure | rootの469file/symlinkと41gitlink、source tarの59,865通常fileを照合 |
| Web ZIP | 705通常fileを照合。661配信fileと44のREADME・NOTICE・license等を含む。全memberが25 MiB未満 |
| formal sourceとGMP | 6ソースの原文license、GMP原archive・manifest・4原文licenseが一致 |

archiveの負の対照ではhash違い、license欠落、絶対パス、親への移動、重複member、外部へ向くsymlink/hardlink、特殊file、既存出力、不要なネットワーク取得を拒否・検出させました。形式検証のstatusやwitnessの負の対照は、まだ実行していません。

集計の原本は [source closure JSON](S15/raw/source-closure-c41e5c5.json)、全661fileのhashは [GitなしWeb照合JSON](S15/raw/git-free-web-c41e5c5.json)です。source closure JSONは、GMPと形式ソースのlicense照合も行う検査器が正常終了した時だけ保存されます。

| 成果物 | SHA-256 |
|---|---|
| toolchain-source-v0.1.0-t6p0.c41e5c5.tar.gz | `c33b4ec1a26de1cbbe6c046e12bd689461e9f8cece248dda01eabc5dbe0fec8c` |
| toolchain-web-v0.1.0-t6p0.c41e5c5.zip | `1ef4c6da097ad185b6f41ebf4f730fb69e0df94b11504553ce5d3fb43754df65` |
| source-closure-c41e5c5.json | `4bb10694ded57111e589eb100d6e14fdcf62439850188f69ddec420ce7011c9f` |
| git-free-web-c41e5c5.json | `b2dd0ca0a412a23081fd034c61972ec096f7abfd0e9fd57e4061a4ac34bb65c2` |

## 再実行

固定ソース、入れ子のsubmodule、npm依存と既存の製品用WASMを準備した対象commitで実行します。

```sh
export PATH="$PWD/vendor/zstd/programs:$PATH"
python3 .github/scripts/check-pins.py consistency
sh tests/check-pins/run.sh
python3 -m unittest discover -s tests/check-release-closure -v
scripts/build-web.sh
scripts/package-release.sh v0.1.0-t6p0.c41e5c5
(cd release && sha256sum -c SHA256SUMS)
```

Gitなしの確認ではsource tarを新しいフォルダーへ展開し、`.git` がないことを確認します。展開先の親を `GIT_CEILING_DIRECTORIES` に指定し、祖先のGit情報へも到達できない状態にします。検証済みの `build/` と `node_modules/` を再利用します。次の `source`、`base`、`generated`、`root` は、それぞれ展開したsource、展開先の親、未作成の資材出力先、元のcheckoutの絶対パスです。

```sh
GIT_CEILING_DIRECTORIES="$base" python3 "$source/scripts/build-library-assets.py" \
  --root "$source" --output "$generated"
(cd "$source" && GIT_CEILING_DIRECTORIES="$base" scripts/build-web.sh)
python3 scripts/audit-release-closure.py --root "$root" --source "$source" \
  --generated-libraries "$generated" --version v0.1.0-t6p0.c41e5c5 \
  --revision c41e5c53d99eff9c604ffe8dec274e49f0189a61 --output build/S15-source-closure.json
```

全dist fileは相対パスとSHA-256の辞書を双方で作って等値比較しました。JSONの全file hashを参照できます。再実行で証拠を上書きせず、別名を使います。

## 失敗と制約

初回のWeb組立は、systemのzstd 1.4.8と既存build-infoの1.5.7が一致せず、配布物を作る前に停止しました。メタデータや検査を緩めず、固定ソースから作成済みのzstd 1.5.7をPATHの先頭に指定して再実行し、成功しました。複数文書を一度に渡した最初のyomiyasu呼び出しも引数エラーになり、各文書を個別に検査し直しました。

GMPの初回取得失敗、別mirrorとの一致、署名鍵の期限切れは、[原本と取得条件の調査](../research/formal-sources.md)に保持します。署名者の信頼まで確認したとは扱いません。

WASM solver、SBY/SMTBMC、proof・反例、5回の正式反復、完全offline起動は未実施です。Tang Nano実機とCloudflare Pages公開も、本リポジトリでは試していません。
