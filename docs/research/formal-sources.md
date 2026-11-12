# 形式検証の固定ソース・依存・配布条件

[調査の索引](../../RESEARCH.md#7-分割した調査) / [原本とブラウザーの制約](formal-verification.md) / [S15](../experiments/S15-formal-verification.md)

## 固定値と確認範囲

採用ソースの正は [RESEARCHの依存表](../../RESEARCH.md) と `.gitmodules`、各gitlinkです。P0はソースと配布条件を登録する段階で、形式検証機能は未提供です。以下のrelease APIの応答は2026-11-02の確認値であり、常に最新とする宣言ではありません。

| ソース | 採用版 | 確認した公開release | ライセンス原本 | 配布と実行の状態 |
|---|---|---|---|---|
| SBY | mainの固定snapshot | latest release APIは404。latest releaseとは呼ばない | [ISC](https://github.com/YosysHQ/sby/blob/79fc9eddca5e33a28cc2f2cd19c9825efd9a7255/COPYING) | ソースのみ。process adapter未接続 |
| Yices2 | yices-2.7.0 | [2025-07-16公開](https://github.com/SRI-CSL/yices2/releases/tag/yices-2.7.0) | [GPL本文](https://github.com/SRI-CSL/yices2/blob/85cf17e44eac76b5d14b297c09fc9bfecf47ef65/LICENSE.txt)と[GPL-3.0-or-later表示](https://github.com/SRI-CSL/yices2/blob/85cf17e44eac76b5d14b297c09fc9bfecf47ef65/copyright.txt) | 優先するビルド候補。未実行 |
| Z3 | z3-5.3.3 | [2026-10-29公開](https://github.com/Z3Prover/z3/releases/tag/z3-5.3.3) | [MIT](https://github.com/Z3Prover/z3/blob/430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e/LICENSE.txt) | 優先するビルド候補。未実行 |
| Boolector | 3.2.4 | [2024-08-23の最終release](https://github.com/Boolector/boolector/releases/tag/3.2.4) | [MIT](https://github.com/Boolector/boolector/blob/393cdfba3735d334bb4e6525500b8a0280dd41e6/COPYING) | 開発・保守終了、archive済み。比較候補であり推奨しない |
| Bitwuzla | 0.9.1 | [2026-05-21公開](https://github.com/bitwuzla/bitwuzla/releases/tag/0.9.1) | [MIT](https://github.com/bitwuzla/bitwuzla/blob/8d1eb01093ae54d9b4586456b69c3bf31000a4c2/COPYING) | Boolector後継の比較候補。追加依存とWASMは未検証 |
| Click | 8.3.1 | [タグ](https://github.com/pallets/click/releases/tag/8.3.1)を採用 | [BSD-3-Clause](https://github.com/pallets/click/blob/1d038f270701498433cb432f54db89f95f07a845/LICENSE.txt) | SBYのPython依存。ソースを登録 |
| GMP | 6.3.0 | [GNU公式配布索引](https://ftp.gnu.org/gnu/gmp/) | archive内のREADMEとCOPYING各本文 | Yices2の候補依存。原archiveをsource archiveへ保存 |

APIの `target_commitish` はbranch名の場合があります。採用commitの代わりには使いません。タグから取得した実際のcheckoutとgitlinkを完全長SHAで固定し、更新監視ではタグの参照先も照合します。GitHubのlicense APIが `NOASSERTION` を返した項目は、実際の原本を読んで判断しました。

## 初期調査snapshotの保持

次の値は初期調査時に読んだソースであり、採用release pinへ書き換えていません。SBYは同じsnapshotを採用しています。

| 対象 | 初期調査commit |
|---|---|
| SBY | `79fc9eddca5e33a28cc2f2cd19c9825efd9a7255` |
| Yices2 | `560f3b375840560a3decaa27c1d2f2e6503c0ab2` |
| Z3 | `8fbb275aba0472e862e289c7af1331b3bd5d512c` |
| Boolector | `43dae91c1070e5e2633e036ebd75ffb13fe261e1` |
| Bitwuzla | `9d391d18612d688ccbb2cdcf226cb85c623d51ff` |

Yices2のrelease説明はMCSATの有限体対応、cache・探索heuristic、portfolio script、SMT2モデル出力の変更を挙げています。初期profileではMCSATとportfolioは使いません。Bitwuzla 0.9.1はSymFPU 1.2.0、浮動小数点の符号付きzeroと量化の修正、`--pp-elim-extracts` の削除を記録しています。Boolectorはこのreleaseで保守を終えています。Z3 5.3.3のrelease本文は版名だけであり、詳細な性能・安全性の改善を推測していません。今回、既存製品のソルバーを更新したわけではなく、初めて候補を登録しています。

## Python依存とSQLite

[SBYのソース](https://github.com/YosysHQ/sby/tree/79fc9eddca5e33a28cc2f2cd19c9825efd9a7255/sbysrc)はClick、sqlite3、argparse、json、os、re、signal、subprocess、shutil、tempfileなどを使用します。Click以外を独立したpip依存として追加するわけではありません。標準ライブラリーにPythonファイルがあるだけでは、拡張moduleや外部processが動く証拠にはなりません。

npmで固定したPyodide 314.0.7のNode実行で、`import sqlite3`、`:memory:`への接続、`SELECT 6*7`、closeを確認しました。SQLiteは3.39.0、結果は42でした。追加の `loadPackage` は呼んでいません。これはPyodide coreのSQLiteを使える確認であり、ブラウザーの永続化、SBY全体の実行、SQLiteの更新監視とソース提供まで完了した証拠ではありません。SQLite自身は [public domain](https://sqlite.org/copyright.html) です。製品へ組み込む前にPyodideの対応ソースと同梱条件も照合します。

再実行には `npm ci` 後、次のコードをリポジトリーのルートで実行します。HDLやソルバーは実行しません。

```sh
node --input-type=module - <<'JS'
import { loadPyodide } from 'pyodide';
const py = await loadPyodide();
py.runPython('import sqlite3, json\nc = sqlite3.connect(":memory:")\nprint(json.dumps({"sqlite": sqlite3.sqlite_version, "result": c.execute("SELECT 6*7").fetchone()[0]}))\nc.close()');
JS
```

Pyodideの `pyodide-lock.json` にはClick 8.3.1、`click-8.3.1-py3-none-any.whl`、SHA-256 `d3118144289833a6a3868e953a63a57f6166b33497e1cbe6231423de27465f78` が記録されています。このwheelはまだ製品へ追加していません。導入時にはPyodide lockから値を導き、wheelと登録ソースの対応、license、Gitなし配布を検査します。別のpinをコードへ複製しません。

## ビルドprofileと無効な依存

| 対象 | 調査した条件 | 最初に比較する条件と未確認点 |
|---|---|---|
| Yices2 | [README](https://github.com/SRI-CSL/yices2/blob/85cf17e44eac76b5d14b297c09fc9bfecf47ef65/README.md)、[configure](https://github.com/SRI-CSL/yices2/blob/85cf17e44eac76b5d14b297c09fc9bfecf47ef65/configure.ac)。gperf 3.0以上、GMP 4.1以上。MCSATはlibpoly/CUDDを使う。thread safetyとMCSATは併用不可 | static、MCSATなし、thread safetyなしを候補とする。gperfはhost生成器。alarm/setjmp、WASIの終了・cancel・メモリーは未確認 |
| Z3 | [CMake](https://github.com/Z3Prover/z3/blob/430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e/CMakeLists.txt)とCMake module。static/shared、Python bindings、GMP、`Z3_SINGLE_THREADED` | static・単一thread・Python bindingsなし・GMPなしの隔離比較を優先。対応するABI、SDK、成功したオプションはP2で記録する |
| Boolector | [setup scripts](https://github.com/Boolector/boolector/tree/393cdfba3735d334bb4e6525500b8a0280dd41e6/contrib) | btor2toolsとSAT backendが必要。固定値・ライセンス・WASMを確認するまで無効 |
| Bitwuzla | [src/meson.build](https://github.com/bitwuzla/bitwuzla/blob/8d1eb01093ae54d9b4586456b69c3bf31000a4c2/src/meson.build)、[options](https://github.com/bitwuzla/bitwuzla/blob/8d1eb01093ae54d9b4586456b69c3bf31000a4c2/meson_options.txt) | GMP 6.3以上、MPFR 4.2.1以上、SymFPUは必須。CaDiCaLは既定有効。追加依存未採用のため無効 |

BitwuzlaのKissat、CryptoMiniSat、Gimsatul、実験的浮動小数点、AIGER、mimallocは既定無効です。ただしsystem libraryが見つかる経路もあるため、単にbooleanの既定値だけで非同梱を断言しません。実ビルド時の依存一覧、link内容、ソースとライセンスを検査します。MPFRはLGPL系、SAT backendやSymFPUも各原本の確認が必要であり、ここで未取得のlicenseを確認済みとは扱いません。

調べた補助ソースの指定値は次の通りです。あくまでupstream設定の転記で、製品の固定値・有効化ではありません。

- Bitwuzlaの [CaDiCaL wrap](https://github.com/bitwuzla/bitwuzla/blob/8d1eb01093ae54d9b4586456b69c3bf31000a4c2/subprojects/cadical.wrap): `rel-2.1.2`、archive SHA-256 `292c2bb8d712d6d05fce3d3df63b922b8fa45e03974a79f7bae5bf68c284f131`。
- Bitwuzlaの [SymFPU wrap](https://github.com/bitwuzla/bitwuzla/blob/8d1eb01093ae54d9b4586456b69c3bf31000a4c2/subprojects/symfpu.wrap): `40bdec00e99f8ea1b96c3dac0a05eed11c541639`。
- Boolectorのsetup: btor2tools `037f1fa88fb439dca6f648ad48a3463256d69d8b`、CaDiCaL `cb89cbfa16f47cb7bf1ec6ad9855e7b6d5203c18`、Lingeling `7d5db72420b95ab356c98ca7f7a4681ed2c59c70`。

この段階ではlibpoly、CUDD、MPFR、SymFPU、SAT backendのバイナリーを配布しません。ソルバーのソースにある設定を登録することと、対応ソースを閉じた実行profileを提供することを分けます。P2のYices2/Z3、P4の追加ソルバーごとに、実際に有効にした依存だけをNOTICEと配布ソースへ加えます。

## GMPの取得・署名・ソース提供

最初の `https://gmplib.org/download/gmp/` への接続は `curl: (7) Failed to connect to gmplib.org port 443` で失敗しました。成功として扱わず、GNU公式mirrorへ切り替えました。[GNUの原archive](https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz)と[別のkernel.org mirror](https://mirrors.kernel.org/gnu/gmp/gmp-6.3.0.tar.xz)のSHA-256は、RESEARCHの固定値と一致しました。

GNUの [detached signature](https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz.sig) と [GNU keyring](https://ftp.gnu.org/gnu/gnu-keyring.gpg) も照合しました。GnuPGはデータとの暗号学的一致を示す `VALIDSIG` とともに `EXPKEYSIG`、`KEYEXPIRED` を返しました。署名日は2023-07-30、鍵のfingerprintは `343C2FF0FBEE5EC2EDBEF399F3599FF828C67298` です。取得したkeyringの期限値は `1672946787` で、署名日より前です。したがって、署名者の有効性を含めて認証済みとはしません。別mirrorの一致も署名者の信頼の代わりにはなりません。

| 取得物 | SHA-256 |
|---|---|
| detached signature | `94def8c1a731854de684689126046ec93589147abd4cd0025f12d741d323aa82` |
| GNU keyring | `8013de59880f7a59f53b6bd207f4d2a408d67b84a82fa9cba1dbbf443428e2db` |

GMPのREADMEはLGPL-3.0-or-laterまたはGPL-2.0-or-laterを示し、ファイルごとの条件はmanualで確認するよう指定しています。Yices2と静的リンクする候補ではGPL-3.0と整合する選択を検討しますが、まだリンクしていません。原archiveとREADME、COPYING、COPYINGv2、COPYINGv3、COPYING.LESSERv3を改変せず保持します。

## 配布と検査

`scripts/prepare-formal-sources.py` はRESEARCHのGMP pinを読み、SHA-256、archiveの全member、licenseを検査します。絶対パス、親への移動、`.git`、重複、外へ向くリンク、特殊file、license欠落、既存出力の上書きを拒否します。Git情報なしの配布ソース内に原archiveがあれば、ネットワークを使わず同じものを再利用します。

`scripts/package-release.sh` は6つのgitlinkのソースをsource archiveへ加え、GMPは `vendor/formal-archives/` 内へ原archiveとmanifestを保持します。Web ZIPには6ソースとGMPのlicense原文を付けますが、形式検証の実行資材はまだ含めません。`scripts/audit-release-closure.py` がcommit、原archive、manifest、ZIPのlicenseを照合します。

pin checkerは6ソースの完全長SHA・版の書式・URL・license・NOTICE、GMPのURLとhash書式を検査します。更新監視はSBYのbranch、他の5件の安定版tag、GMPのGNU配布索引を調べます。tagとgitlinkの不一致、取得・解析失敗は要確認です。ソース取得のhash一致だけを、バイナリーの正しい動作や無期限の安全性の証拠にはしません。

残る実行時のABI、SDKの実版、static/shared、thread設定、初期heap・上限、起動と実行の時間、最大入力、license closureは、ビルドして試したprofileごとにS15へ記録します。P0時点ではそれらの実測値はありません。

P0の固定ソースと原archiveは、`c41e5c53d99eff9c604ffe8dec274e49f0189a61` で配布物へ組み立て、[配布ソース・license・Git情報なしの再生成を照合](../experiments/S15-formal-source-closure.md)しました。これを、SBYやソルバーのビルド・形式検証の成功とは扱いません。
