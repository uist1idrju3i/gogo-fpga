# 測定の落とし穴

## このリポジトリで実際に起きたこと

| 落とし穴 | 実例 | 対策 |
|---|---|---|
| 版を文字列の順で比べる | emsdk のタグを文字列の順で並べ、6.0.9 を 6.0.13 より新しいと誤った（RESEARCH.md「依存関係」） | `git ls-remote --tags --sort=-v:refname` など、版の順で並べる |
| 古い成果物を測る | Playwright が、段階 0 のときにできた WASM と古い画面を相手にテストしていた（[PR #5](https://github.com/gogo-fpga/flasher/pull/5)） | 測る前に成果物を作り直し、`build-info.json` の SHA-256 と照らし合わせる |
| 成果物がビルドの場所に依存する | emsdk のパスが WASM に埋め込まれ、`BUILD_ROOT` を変えると SHA-256 が変わった（[PR #5](https://github.com/gogo-fpga/flasher/pull/5)） | `-ffile-prefix-map` で emsdk のパスも置き換え、別の場所で 2 回ビルドして一致を確かめる |
| 最適化の指定が重なる | upstream の CMake が `-O3` を足し、`-Os` と重なっていた（[移植元の実験 S1b](https://github.com/gogo-fpga/flasher/blob/dcbeb67/docs/experiments/S1b-option-matrix.md)） | `flags.make`、`Makefile`、`link.txt` で、指定が 1 つだけであることを確かめる |
| 検査器の誤りを製品の誤りと取り違える | 20K の `--verify` の失敗は、仮想デバイスの MPSSE のビットの詰め方の誤りだった（[PR #5](https://github.com/gogo-fpga/flasher/pull/5)） | 失敗したら、まず仮想デバイスを仕様（FTDI AN_108 など）と照らし合わせる |
| 出力の経路が遅さの原因になる | 大きな NOR の内容を stderr で base64 にして渡したため、テスト全体が 900 秒を超えた（[PR #6](https://github.com/gogo-fpga/flasher/pull/6)） | 大きな結果はファイルで渡す。単独の実行と全体の実行の両方で時間を測る |
| 終了コードだけで判定する | upstream は `FAIL` を表示しても 0 を返す場合がある（[移植元の実験 S1a](https://github.com/gogo-fpga/flasher/blob/dcbeb67/docs/experiments/S1a-program-sim.md)） | ログと仮想デバイスの状態も判定に使う |
| 仮想デバイスの値を実機の値として書く | 仮想 USB での書き込み時間は、実機の USB の遅延を含まない | 「仮想デバイスでの値」と明記し、実機の値と書かない |

## 一般的な規則

| 規則 | 出典 |
|---|---|
| 改善する指標だけでなく、劣化しうる指標も測る。都合のよい部分だけを選ばない | Heiser, Systems Benchmarking Crimes A1・A2（https://gernot-heiser.org/benchmarking-crimes.html） |
| ばらつきを示し、相対値だけで書かない。環境の仕様を書く | 同 B4・E1・E3 |
| シミュレーションでの測定は、そうと明記する。調整に使ったデータで評価しない | 同 C1・C3 |
| 実験のスクリプト、入力、生の値、解析のスクリプトを残す | ACM Artifact Review and Badging（https://www.acm.org/publications/policies/artifact-review-and-badging-current） |
| 覆った結論も消さず、置換として残す | Nygard, Documenting Architecture Decisions（https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions） |
