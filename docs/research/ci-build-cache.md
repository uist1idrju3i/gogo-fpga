# CIのビルドキャッシュ

[調査の索引](../../RESEARCH.md#7-分割した調査)へ戻る。

この文書はビルドとCIを保守する開発者向けです。測定の条件・生データ・採否の基準は [S16](../experiments/S16-ci-build-cache.md) に記録します。S8の既存キャッシュを拡張しますが、ReleaseのビルドやPages公開の承認手順は変えません。

## 保存する範囲

`.github/workflows/build.yml` は、YosysのWASI/native出力に加え、openFPGALoader、nextpnrのWASI/native出力とchipdb、GHDLのWASM/native出力、Icarusの両版、decoder、Surferの配布資材を保存します。選択したパスは `scripts/ci-build-cache.py` の `COMPONENTS` にまとめます。SDK、ビルド依存、packのダウンロードとfixtureも、同じキーと整合性検査の方式に揃えます。Cargoは作業領域内のtargetを対象とし、ホームのregistryは新方式では保存しません。

出力があればコンパイルだけを省きます。nextpnr、GHDL、Icarus、Surferでは入力キャッシュの転送も省きます。キャッシュがなければ、従来と同じビルドコマンドを実行します。openFPGALoaderの出力を復元した場合も、固定emsdkを有効化し、Web組立の既存の完全な `build-info.json` 検査を通します。

packの資材検証、WASM/native比較、形式検証、仮想USB、Web単体、配布物、Playwrightの検査は省きません。mainのWeb成果物も毎回組み立てます。キャッシュのmanifestは `build/.ci-cache/` に置き、公開用の `public_html/` へは入れません。

## キーと復元の検査

完全一致のキーだけを使い、`restore-keys` による近いキーからの復元は行いません。キーには次を含めます。

- `git ls-tree -r HEAD` の全gitlink。nested submoduleの固定値は、その親gitlinkの内容に含まれます。
- 追跡した `scripts/`、`patches/`、`.github/`、fixtureの全ファイルのSHA-256。
- pinの参照元である `RESEARCH.md` 全体、npmとpipのlock・pin、Nodeの固定値、`.gitmodules`、license情報、ボード定義。
- runnerのOS、CPUアーキテクチャ、`ImageOS`、`ImageVersion`、インストール済みdpkgパッケージの版、作業領域の絶対パス、ビルドに使う環境変数。
- 手動更新用の `SALT` とcomponent名。キーの入力が不明なrunnerでは失敗させます。

安全側に広く含めたため、`RESEARCH.md` の本文だけの変更やCI設定の変更でも無効になります。frontendだけの変更は、ボード定義、依存や上記のファイルを変えなければ再利用できます。runner imageの更新やaptで入るパッケージの版の変化もmissになります。

openFPGALoaderのスクリプトは親commitの日付を `SOURCE_DATE_EPOCH` に使うため、この出力のキーにはその日付も含めます。異なる日付のUI変更では、このcomponentの再利用を見込みません。日付の扱いを変える最適化は、別の再現性比較が必要です。

保存時には全ファイルのSHA-256、大きさ、権限、ディレクトリーとsymlinkの構成をmanifestへ記録します。復元直後に同じ構成を再計算し、不足、追加、1 byteの改変、権限の変更、キーの相違を検出するとジョブを失敗させます。出力のsymlinkは同時に保存した対象内だけを許します。入力キャッシュのvenvなどのsymlinkはリンク先文字列を記録し、外部のrunnerファイルをたどりません。runner側の版はキーで区別します。既存の成果物manifestと後続の機能検査も維持します。

このmanifestは破損検出用で、悪意ある保存者によるmanifestの再作成を防ぐ署名ではありません。保存者を制限する規則と組み合わせます。

## 保存者と運用

復元と保存はcommit SHAで固定した `actions/cache/restore` と `actions/cache/save` に分けます。保存は `refs/heads/main` のpushまたはscheduleだけで、成功したproducerジョブの末尾で行います。manifest作成と保存の両stepに条件を置きます。PRと手動実行は復元だけです。GitHubのref別キャッシュの制限により、PRが自分のmerge refへ保存してもmainからは参照できません。main用のキーをPRの入力から選ぶ仕組みも追加しません。

scheduleは復元せず、常にcold buildを行い、成功後の保存は許します。手動実行の `cache=false` は復元も保存もしません。同じキーのキャッシュは上書きできないため、破損時は原因を調べ、必要なら `SALT` を更新します。検査失敗を無視して再利用したり、近いキーへ戻したりしません。

新しいパス別のジョブ省略は追加しません。required checkの名前と依存関係、既存の文書差分判定は維持します。UIだけの変更でも全ての正しさの検査を実行し、キャッシュでコンパイルを短縮します。cache actionはworkflowへ直接記載し、既存のpin checkerとzizmorで検査します。zizmorの除外は追加していません。

初回PRは新しいキーでcold missになります。マージ後のmain pushで保存し、次のPRで同じ入力・image・パッケージのキーが `verified-hit` になることを確認します。各ジョブのsummaryにcomponent、状態、キーを記録します。容量と転送・hash時間も測り、古いPR用キャッシュが残る移行期のevictionを区別してください。
