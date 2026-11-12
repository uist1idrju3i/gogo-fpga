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

[UX検査結果](out/ux-report.md)のverdictがpassで、failとunknownがともに0であることを確認します。これは宣言した規則への適合であり、画面の使いやすさや実機の安全性を保証するものではありません。画像を使うvision reviewは助言であり、契約や検査の判定を書き換えません。今回はvision reviewも画面変更も行っていません。

## 状態遷移の実装

`web/lib/design-flow.mjs`は`design_flow`の純粋な遷移関数です。`transitionDesignFlow(state, event, context)`が次の状態名を返します。guardはcontextの各名前に真偽値を渡し、明示したtrueだけを許可します。`&&`は両条件がtrueの場合だけ成立し、複数候補は契約の順序で選びます。未定義のeventや不成立のguardでは状態を保ち、不正な状態名では例外を返します。actionsやentryの副作用は実行せず、UIへの接続もまだ行いません。

`node --test tests/web/design-flow.test.mjs`は生成したXState投影を読み、全状態・event・target・guard・actionと全guardの組み合わせを照合します。古い成果物を表すstaleからは、write_requestedでもwritingへ進みません。
