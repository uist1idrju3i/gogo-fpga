# 午後のFPGAのUX契約

開発者が操作の流れと実装の一致を確かめるための契約です。[調査索引](../../RESEARCH.md#7-分割した調査)へ戻れます。

## 原本と生成物

[gogo-fpga.ux.rb](gogo-fpga.ux.rb)が編集する原本です。変更後は固定したDockerイメージでJSON契約と投影を生成し直します。[gogo-fpga.ux.json](gogo-fpga.ux.json)と`out/`は生成物なので、手で編集しません。`out/`には状態遷移、ジャーニー、設計図のテキストと、検査結果・hashの記録があります。PNGやSVGのプレビューは保存していません。

リポジトリーのルートで次を実行します。ホストにはDockerだけが必要で、Rubyや描画ツールをホストで実行しません。

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" -w /workspace \
  ghcr.io/vibebb/ux-tools@sha256:4b935a28dd73186b2fb7831183657e61c49d10a4df75a51aaabfeb5f6ec8b21b \
  python -m ux_creator from-ruby docs/ux/gogo-fpga.ux.rb \
  --out docs/ux/gogo-fpga.ux.json &&
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" -w /workspace \
  ghcr.io/vibebb/ux-tools@sha256:4b935a28dd73186b2fb7831183657e61c49d10a4df75a51aaabfeb5f6ec8b21b \
  python -m ux_creator author docs/ux/gogo-fpga.ux.json \
  --workspace /workspace --out docs/ux/out
```

[UX検査結果](out/ux-report.md)のverdictがpassで、failとunknownがともに0であることを確認します。これは宣言した規則への適合であり、画面の使いやすさや実機の安全性を保証するものではありません。画像を使うvision reviewは助言であり、契約や検査の判定を書き換えません。vision reviewは行っていません。契約の検査と各実装段階の画面確認は別に扱います。

## U2の画面への接続と判断

[PR #7](https://github.com/uist1idrju3i/gogo-fpga/pull/7)で、編集・合成・検証・書き込みの工程表示と実際の編集、ビルド、書き込みを接続しました。編集中は実行中のjobとせず「現在」と表示します。古い成果物は書き込めず、合成し直すまで操作を無効にします。IDCODEが選んだボードと異なる場合や不明な場合の強制書き込みは、安全側に止めるため意図的に削除しました。

主操作は状態に応じた一つのボタンにし、右paneをボード・書き込み・検証・AIのtabに分けました。シミュレーションと形式検証の操作・設定は検証tab、左paneはファイルだけにまとめます。390pxではエディターを先に置き、主操作を下部に固定し、paneをsheetとして開きます。初回案内はブラウザーごとに閉じた状態を覚え、狭い画面では折りたたみます。

再読み込みした生成済み `.fs` は鮮度の証明を保存していないため、古い成果物として扱います。ツールの読み込み表示は検証済みの取得・cache hitに基づき、読み込み後に初回取得の案内を残しません。結果要約は実際の資源量・Fmax・警告数を使い、取得できない値は未取得として表示します。問題一覧からソースへ移動でき、位置が得られない診断はその旨を明示します。

別ボード用の `.cst` には、既存templateにデータがある場合だけ、選んだボードの制約を作る操作を用意しました。元の制約は `.bak.txt` に残し、ピン情報を推測で補いません。これらの実装は `web/lib/workflow-ui.mjs`、`web/lib/build-summary.mjs`、`web/lib/templates.mjs` にあります。

各U2段階で4ボードを1280・1024・390pxで撮影し、ビルド完了、古い成果物、初回案内、結果要約も目視確認しました。画像そのものは版管理していません。`tests/e2e/workflow.spec.mjs` と `tests/e2e/ide.spec.mjs` などの操作検査、下記の契約検査、目視確認は別々の証拠です。実機のTang Nanoでの確認と非Chromiumの画面確認は、本リポジトリーでは行っていません。現在のAI tabの実装は[A1・A2の記録](../research/editor-and-ai.md#a1-openrouter-接続の実装)を参照してください。

## 状態遷移の実装

`web/lib/design-flow.mjs`は`design_flow`の純粋な遷移関数です。`transitionDesignFlow(state, event, context)`が次の状態名を返します。guardはcontextの各名前に真偽値を渡し、明示したtrueだけを許可します。`&&`は両条件がtrueの場合だけ成立し、複数候補は契約の順序で選びます。未定義のeventや不成立のguardでは状態を保ち、不正な状態名では例外を返します。この関数はactionsやentryの副作用を実行せず、UIからは`web/lib/workflow-ui.mjs`を経由して呼びます。

`node --test tests/web/design-flow.test.mjs`は生成したXState投影を読み、全状態・event・target・guard・actionと全guardの組み合わせを照合します。古い成果物を表すstaleからは、write_requestedでもwritingへ進みません。

`web/lib/ai-chat-flow.mjs` は `ai_chat` の遷移を扱います。本文の確認前や、確認を取り消した後には送信へ進みません。`tests/web/ai-chat-flow.test.mjs` で生成した投影と照合します。受信が正常に完了するまで変更提案を作らず、適用の可否は送信時のファイルの SHA-256 と作業中の処理も確かめて決めます。
