# AGENTS.md

このリポジトリー「午後のFPGA Web Toolchain」で作業するすべての AI エージェントと人間が守るルールです。Devin、Codex、Claude Code などを対象にします。

## 1. main ブランチ

- GitHub のルールセットで `main` を保護しています。直接 push せず、`<agent>/<short>` ブランチで作業して PR を作成します。
- エージェントは PR をマージしません。ルールセットやリポジトリの設定も変更しません。
- 作業前に `git branch --show-current` を確認し、`main` では作業しません。
- 誤って `main` にコミットした場合は push も reset もせず、新しいブランチに移して報告します。
- 先行する PR のマージ後は、`origin/main` から新しいブランチを切ります。

## 2. 言語と書式

- ドキュメント、Issue、Pull Request のタイトルと本文、コミットメッセージは日本語で書きます。Web 画面の文言も日本語です。
- コード、識別子、ファイル名、コマンドは英語のままにします。
- 日本語の文章を書いたら、推敲スキル「yomiyasu」で読みやすさを整えます（後述）。
- 追跡しているテキストファイルの文字は JIS X 0213:2004 の範囲に収めます。CI の `agent-docs` ワークフローが検査します。
- 範囲外の文字を残してよいのは、upstream 由来のファイルと原文の引用だけです。引用は原文を書き換えずにコードスパン・コードブロック・引用行（`>`）で囲み、`.github/jisx0213-allowlist.tsv` に理由を一行で書きます。手順は「jisx0213-text」スキルに従います。

## 3. 対応範囲

- 作るのは Web 版だけです。CLI やネイティブのバイナリーは作りません。
- 配信先は Cloudflare Pages です。公開は、人間が実機の Tang Nano で動作を確かめてから行います。エージェントはデプロイせず、Cloudflare の設定も変えません。
- GitHub Pages は応答ヘッダー（COOP/COEP）を設定できないため使いません。
- 配信のヘッダーは `web/_headers` に書き、`dist/serve.py` と同じにします。1 ファイルは 25 MiB 未満にします（ビルドで検査します）。
- CI の成果物と Release の zip でも配布します。
- 対象は Sipeed Tang Nano 1K・4K・9K・20K です。FPGA の内蔵 SRAM に構成を書き込めることを選定理由とします。ボードを増やすときは、upstream の対応、IDCODE、フラッシュの構成を公式の資料とソースで確かめてから計画します。
- HDL は VHDL と Verilog を最初から対象にします。SystemVerilog と Verilator は将来の段階です。
- openFPGALoader、Yosys + ABC、GHDL、nextpnr-himbaechel、Apicula、NVC、Icarus Verilog、形式検証ソルバーは、upstream のソースを WASM にビルドして使います。機能を手作業で移植しません。upstream へのパッチが避けられない場合は `patches/` に置き、理由を RESEARCH.md に記録します。
- T0 で実装しているのは書き込み部だけです。書き込み部は午後のFPGA Web Flasher から移植し、JSPI、pthread、`-fwasm-exceptions`、COOP/COEP を使います。合成・配置配線のツールでは、実験で必要性が示されない限り JSPI と pthread を使いません。
- すべての自動検査は fail closed にします。必要なツールやファイルがない場合、または出力を解析できない場合は失敗として扱います。
- `.cst` はプロジェクトのピン割り当てから生成し、手で編集しません。
- ツールのバージョンと依存の pin は、pin checker が検査するファイルを正とします。ソースコードなどに二重の固定値を持たせません。
- 書き込み部（openFPGALoader）は Emscripten でビルドします。合成・配置配線のツール（Yosys、nextpnr）と展開器（zstd、xz）は WASI SDK で、GHDL の合成部は AdaWebPack の Ada のコンパイラーと WASI SDK でビルドします。Apicula は Pyodide（Emscripten 製）で動かします。自分でビルドするものはすべて、オプションを安定性を最優先にし、そのうえで実行速度で選びます。変更するときは「experiment-record」スキルで比べてから決め、採用した設定と理由を RESEARCH.md に残します。

## 4. 実機と仮想デバイス

- 実機の Tang Nano では試していません。実機で確かめていないことは「本リポジトリでは試していない」と書き、確認済みのようには書きません。
- 仮想の FT2232・GOWIN TAP・NOR フラッシュ（`tests/sim/fake-webusb.mjs`）で測った時間は、実機の値として扱いません。
- 仮想デバイスを変えるときは「fake-usb」スキルに従い、upstream の手順に合わせ、失敗を検出できることを負の対照で確かめます。
- upstream の openFPGALoader は、失敗しても終了コード 0 を返す場合があります。画面はログの `FAIL` も見て判定します。この判定を緩めません。

## 5. 外部リポジトリ（vendor/、third_party/）

- 書き込み部などの外部コードは `vendor/` の shallow submodule として管理し、ファイルを直接編集しません。`.gitmodules` の `shallow = true` を維持します。
- 外部 HDL ライブラリーと CPU コアは、pin を固定した shallow submodule として `third_party/` から参照します。ソースを本リポジトリーへコピーしません。採用する各ライブラリーとコアのライセンスを記録します。
- 依存を追加・更新するときは「vendor-update」スキルに従います。
- 上流への Issue・PR・push・コメントは、人間の承認を得てから行います。

## 6. 依存関係の管理

`.github/dependabot.yml` では、branch を追う submodule（yomiyasu）、GitHub Actions、npm、pip を週次で更新対象にします。`libftdi` は Dependabot から取得元 `developer.intra2net.com` に接続できません。そのため、「固定版の更新確認」ワークフローが `vendor/libftdi` の branch 先端を調べ、差があれば Issue で知らせます。タグで固定した submodule（openFPGALoader、libusb、zlib、emsdk、Yosys、nextpnr、zstd、xz-embedded、GHDL、Icarus Verilog）、WASI SDK、Boost・Eigen のアーカイブ、Apycula、Node.js、actionlint、runner も同じワークフローの対象です。AdaWebPack のリリースのアーカイブと、GCC の libgnat の commit も、同じワークフローの対象です。GHDL のビルドに使う Ubuntu のパッケージ（gprbuild などと libxml2）は、版と SHA-256 を固定し、照合だけを行います。

Pyodide に同梱する NumPy、msgspec、micropip は、npm の `pyodide` パッケージに含まれる `pyodide-lock.json` の版と SHA-256 に従います。Dependabot が `pyodide` を更新すれば、この 3 つも一緒に更新されます。`tests/fixtures/requirements.txt` の Apicula は、`yowasp-nextpnr-himbaechel-gowin` が版を固定しているため Dependabot の対象から外しています。

`requirements-nextpnr.txt` は Dependabot の pip 対象です。依存を追加する際は、同じ変更で監視対象にも加えてください。

Dependabot の PR を含むすべての更新で「vendor-update」スキルの変更履歴の確認と回帰テストを行います。マージは人間が行います。

## 7. エージェントスキル

- リポジトリ固有のスキルは `.agents/skills/<name>/` に置きます。vendor 内のスキルはコピーせず、`.agents/skills/<name>` からのシンボリックリンクにします。
- Claude Code は `.claude/skills/` しか読まないため、`.claude/skills/<name>` → `../../.agents/skills/<name>` のリンクも必ず作ります。スキルを追加・改名・削除したら、リンクも同じ PR で直します。CI の `agent-docs` ワークフローがリンクの解決を検査します。Windows で clone するときは、シンボリックリンクを有効にします（`git config core.symlinks true` と、開発者モードか管理者権限）。
- 個人用の設定はコミットしません（`CLAUDE.local.md`、`.claude/settings.local.json`、`AGENTS.override.md` は gitignore 済み）。

| スキル | 使う場面 |
|---|---|
| `yomiyasu` | 日本語文書の推敲（`vendor/yomiyasu` へのリンク） |
| `jisx0213-text` | 範囲外の文字の置き換え、引用と upstream ファイルの例外 |
| `vendor-update` | 依存関係の変更履歴、採否、ライセンス、回帰テストの確認 |
| `experiment-record` | 実験・測定・比較の計画、実行、再現できる記録 |
| `fake-usb` | 仮想の FT2232・GOWIN TAP・NOR フラッシュの拡張と、負の対照 |
| `document-structure` | 文書の意味単位による分割、索引・旧リンク・証拠の保持、サイズと例外の検査 |

## 8. yomiyasu（日本語推敲スキル）

`vendor/yomiyasu` にある、AI が生成した日本語を読みやすく整えるスキルです。意味と条件を保ったまま、不自然な比喩、曖昧な主述関係、不要な装飾を直します。

- 呼び出し方: `/yomiyasu`、`$yomiyasu:yomiyasu`（Codex 系）、`yomiyasu:yomiyasu`（Claude Code）。依頼の文に「yomiyasu で」と書いても呼べます。
- 検査ツールは Python の標準ライブラリだけで動き、外部へ通信しません。
  - `python3 .agents/skills/yomiyasu/scripts/yomiyasu_lint.py <file>`: AI の文章に多い表現の候補を出します。
  - `python3 .agents/skills/yomiyasu/scripts/yomiyasu_check.py run --source <原文> --final <最終稿>`: 推敲の前後を比べ、数値・否定・主述が変わっていないかを確かめます。記録は git 最上位の `.yomiyasu/` に残ります（gitignore 済み）。
- 自動フックの `yomiyasu_hook.py` は各開発者の個人設定でだけ有効にし、リポジトリにはコミットしません。

## 9. 作業の進め方

- 自明でない作業は、調査して深い計画を立ててから着手します。計画はリポジトリにコミットせず、チャットで共有します。
- 調査の結果は `RESEARCH.md` にまとめ、大きな主題は `docs/research/<topic>.md` に分けて置き、`RESEARCH.md` の 7 章からリンクします。実験・測定・比較は「experiment-record」スキルに従って `docs/experiments/` に残します。結果を PR 本文だけに書きません。
- 文書は目的・読者・主題・手順・証拠の意味単位で分け、索引と旧リンク、条件、失敗記録、ライセンス、原典を保持します。行数による切断や、上限を避けるだけの細分化はしません。手順は「document-structure」スキルに従います。
- 追跡した Markdown は UTF-8 で20,000バイトを超えたら分割を検討し、40,000バイトを超えたら分割または理由付き例外を必須にします。上流原文・法的文書・生成証拠・一体性を保つ記録に限る例外は、`.github/document-size-allowlist.tsv` に正確なパス・種別・上限・理由を記録し、不要になったら削除します。
- 文書の根拠に、VM や個人環境のパスを書きません。リポジトリ内のファイル、upstream のファイルと行番号、CI の成果物、公開 URL を示します。
- 画面を変えたら、4 ボードのスクリーンショットを撮って目で確かめ、PR 本文に確かめた範囲を書きます。
- 変更は小さく、主題ごとにまとめます。
- 検証は、push する commit と同じ状態で行います。手元だけの変更を含む状態での成功は、push した commit の確認になりません。

## 10. 確認コマンド

```sh
git submodule update --init --depth 1    # submodule の取得
git -C vendor/emsdk fetch --depth=1 --tags origin  # build-wasm.sh に必要な emsdk のタグを取得。CI の build.yml と同じ
git submodule update --init --depth 1 -- vendor/yosys
git -C vendor/yosys submodule update --init --depth 1 -- abc libs/cxxopts libs/fmt libs/tomlplusplus libs/boost_regex libs/symfpu
git submodule update --init --depth 1 -- vendor/nextpnr
npm ci                                   # Pyodide、Playwright、esbuild などを取得
npx playwright install --with-deps chromium
scripts/build-wasm.sh                    # openFPGALoader を WASM にする（build/jspi-pthread/）
scripts/build-synth-wasm.sh              # Yosys を WASI SDK でビルドする
scripts/build-synth-wasm.sh --native     # Yosys のネイティブ参照版をビルドする
node --test tests/synth/*.test.mjs       # WASM とネイティブの合成結果を比較する
scripts/build-pnr-wasm.sh                # nextpnr と Gowin chipdb を WASI SDK でビルドする
scripts/build-pnr-wasm.sh --native       # nextpnr のネイティブ参照版をビルドする
scripts/build-decoders.sh                # zstd と xz の decoder を WASI SDK でビルドする
sh scripts/prepare-compressed-assets.sh dist # 圧縮比較用資材を dist/bench/ に作る
node scripts/bench-decompress.mjs --base-url http://127.0.0.1:8000 --repeats 5 --out build/S4B.csv # Chromium で圧縮資材の展開時間を測る
node --test tests/synth/nextpnr.test.mjs # nextpnr の WASI/native 結果と負の対照を検証する
node --test tests/synth/wasi-p1.test.mjs # WASI Preview 1 shim と nextpnr/Yosys の一致を検証する
scripts/build-pack-assets.sh             # Pyodide、Apicula、NumPy、msgspec を検証して build/pack/ に配置する
node --test tests/synth/gowin-pack.test.mjs # Pyodide と native の .fs を比較する
scripts/build-web.sh                     # 画面、WASM、Pyodide assets を dist/ にまとめる
tests/fixtures/build-fs.sh               # 4 ボード用の .fs を作る（build/fixtures/）
node --test tests/web/*.test.mjs         # 画面の部品の単体テスト
WASM_BUILD_ROOT=build node --test --test-concurrency=1 tests/sim/*.test.mjs  # 仮想 USB での検出・書き込み
npx playwright test                      # 画面の E2E（既定は 8000。使用中なら PLAYWRIGHT_PORT=8123 を指定）
scripts/package-release.sh v0.1.0        # 配布物とライセンス本文を検証する
python3 dist/serve.py --port 8000        # COOP/COEP 付きでローカル配信
shellcheck scripts/*.sh tests/fixtures/*.sh tests/check-*/run.sh
python3 .github/scripts/check-jisx0213.py
python3 .github/scripts/check-links.py
actionlint .github/workflows/*.yml
python3 .github/scripts/check-pins.py consistency
sh tests/check-pins/run.sh
sh tests/check-jisx0213/run.sh
sh tests/check-links/run.sh
python3 .github/scripts/check-document-size.py
sh tests/check-document-size/run.sh
python3 -m venv "$HOME/.cache/toolchain-zizmor"
"$HOME/.cache/toolchain-zizmor/bin/pip" install --require-hashes -r .github/zizmor-requirements.txt
"$HOME/.cache/toolchain-zizmor/bin/zizmor" --offline --format=github .github/workflows/
python3 .agents/skills/yomiyasu/scripts/yomiyasu_lint.py <file>
git diff --check
```

ビルドには Autotools（autoconf、automake、libtool）が必要です。`scripts/build-wasm.sh` は、使えない Autotools を見つけると止まります。
