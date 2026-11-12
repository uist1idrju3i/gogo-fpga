# frozen_string_literal: true

# 午後のFPGA の UX 契約。`python -m ux_creator from-ruby` で gogo-fpga.ux.json を作る。
# 重要度・満足度は、既存の画面の観察と調査に基づく仮説の値（利用者調査の実測ではない）。

UX.design "gogo-fpga" do
  persona :first_timer, name: "初めて FPGA を触る人",
          goals: ["インストールなしで L チカを書き込む", "何が起きているかを理解する"],
          context: "Tang Nano を買ったばかり。Windows か Chromebook の Chrome",
          pains: ["ツールのインストールと設定", "初回の大きな読み込み", "英語のエラーが読めない"]
  persona :learner, name: "授業や演習で使う学生",
          goals: ["配られた課題を開いて動かす", "シミュレーションで確かめてから提出する"],
          context: "管理された端末でソフトを入れられない。時間が限られている",
          pains: ["端末ごとの環境差", "保存した場所がわからない", "ピン割り当ての間違い"]
  persona :maker, name: "Gowin IDE を使ってきた人",
          goals: ["編集から書き込みまでを短く繰り返す", "資源使用率とタイミングを見る"],
          context: "自作 CPU や周辺回路を作る。キーボード中心",
          pains: ["IDE の重さとライセンス", "ログの中から問題を探す手間"]

  job :first_blink,
      functional: "テンプレートから最初の書き込みまでを 10 分以内に終える",
      emotional: "自分にもできたという手応え",
      social: "動いたボードを人に見せられる",
      importance: 9, satisfaction: 3
  job :understand_errors,
      functional: "合成・配置配線・書き込みの失敗の原因の行と直し方を知る",
      emotional: "行き詰まらずに次の一手がわかる安心",
      social: "質問するときに状況を正確に伝えられる",
      importance: 9, satisfaction: 3
  job :iterate_design,
      functional: "編集から合成・書き込みまでを少ない操作で繰り返す",
      emotional: "待たされずに集中が続く",
      social: "作業の速さで周りに遅れない",
      importance: 8, satisfaction: 4
  job :assign_pins,
      functional: "設計の信号をボードのピンに正しく割り当てる",
      emotional: "ボードを壊さないかという不安がない",
      social: "配線図と一致した設計を共有できる",
      importance: 8, satisfaction: 4
  job :flash_safely,
      functional: "SRAM かフラッシュかを選び、書き込みの成否を確実に知る",
      emotional: "成功したと信じてよいという確信",
      social: "動かない原因を書き込みのせいにしなくて済む",
      importance: 8, satisfaction: 4
  job :verify_before_write,
      functional: "シミュレーションと形式検証で書き込む前に動作を確かめる",
      emotional: "実機で悩む前に間違いを見つけられる余裕",
      social: "検証した設計として提出できる",
      importance: 6, satisfaction: 4
  job :keep_projects,
      functional: "プロジェクトを失わずに保存し、ZIP で受け渡す",
      emotional: "閉じても消えないという安心",
      social: "課題や作品を他の人と交換できる",
      importance: 7, satisfaction: 5
  job :ask_ai,
      functional: "AI に設計やエラーを相談し、変更を差分で確かめて取り込む",
      emotional: "知らないことを気軽に聞ける心強さと、勝手に書き換えられない安心",
      social: "どこを AI に頼ったかを説明できる",
      importance: 7, satisfaction: 2

  journey :first_session, persona: "first_timer" do
    stage :arrive, kind: :onboard, touchpoints: %w[support_check], emotion: 3,
          pain_points: ["対応ブラウザーかどうかがすぐにわからない"],
          surfaces: %w[web_app], jobs: %i[first_blink]
    stage :choose_board, kind: :onboard, touchpoints: %w[board_select], emotion: 3,
          pain_points: ["ボードの型番と名前の対応がわからない"],
          surfaces: %w[web_app], jobs: %i[first_blink assign_pins]
    stage :start_template, kind: :onboard, touchpoints: %w[template_open], emotion: 4,
          surfaces: %w[web_app], jobs: %i[first_blink]
    stage :first_build, kind: :use, touchpoints: %w[tool_download build_progress], emotion: 2,
          pain_points: ["初回に約 79 MB を読み込む", "どこまで進んだかわからない"],
          surfaces: %w[web_app tool_workers], jobs: %i[first_blink iterate_design]
    stage :connect_board, kind: :use, touchpoints: %w[usb_permission], emotion: 2,
          pain_points: ["WebUSB の許可ダイアログの意味がわからない", "ドライバーの差し替えが要る OS がある"],
          surfaces: %w[web_app tang_nano], jobs: %i[flash_safely]
    stage :first_write, kind: :use, touchpoints: %w[write_progress write_result], emotion: 5,
          surfaces: %w[web_app tang_nano], jobs: %i[first_blink flash_safely]
  end

  journey :daily_work, persona: "maker" do
    stage :reopen, kind: :use, touchpoints: %w[project_list save_status], emotion: 4,
          surfaces: %w[web_app project_store], jobs: %i[keep_projects]
    stage :edit, kind: :use, touchpoints: %w[editor pin_table], emotion: 4,
          pain_points: ["ピン割り当てとコードが別の場所にある"],
          surfaces: %w[web_app], jobs: %i[iterate_design assign_pins]
    stage :build, kind: :use, touchpoints: %w[build_progress build_summary], emotion: 3,
          surfaces: %w[web_app tool_workers], jobs: %i[iterate_design]
    stage :fix_errors, kind: :recover, touchpoints: %w[problem_list editor], emotion: 2,
          pain_points: ["ログが長く、問題の行へ移れない", "古い成果物を書き込んでしまう"],
          surfaces: %w[web_app], jobs: %i[understand_errors]
    stage :verify, kind: :use, touchpoints: %w[sim_run waveform formal_run], emotion: 3,
          pain_points: ["設定が左の列の奥にあり見つけにくい"],
          surfaces: %w[web_app tool_workers], jobs: %i[verify_before_write]
    stage :write, kind: :use, touchpoints: %w[write_progress write_result], emotion: 4,
          surfaces: %w[web_app tang_nano], jobs: %i[flash_safely iterate_design]
    stage :share, kind: :exit, touchpoints: %w[zip_export], emotion: 4,
          surfaces: %w[web_app project_store], jobs: %i[keep_projects]
  end

  journey :ai_help, persona: "learner" do
    stage :connect_ai, kind: :onboard, touchpoints: %w[ai_consent openrouter_auth], emotion: 3,
          pain_points: ["何が外部へ送られるのか不安", "鍵がどこに保存されるのか不安"],
          surfaces: %w[web_app openrouter], jobs: %i[ask_ai]
    stage :ask, kind: :use, touchpoints: %w[ai_context_preview ai_chat], emotion: 4,
          surfaces: %w[web_app openrouter], jobs: %i[ask_ai understand_errors]
    stage :review_change, kind: :use, touchpoints: %w[ai_diff], emotion: 4,
          pain_points: ["提案が複数ファイルにまたがると全体が見えない"],
          surfaces: %w[web_app], jobs: %i[ask_ai iterate_design]
    stage :disconnect, kind: :exit, touchpoints: %w[ai_disconnect], emotion: 4,
          surfaces: %w[web_app], jobs: %i[ask_ai]
  end

  service_blueprint frontstage: %w[editor board_select build_summary problem_list waveform write_panel ai_panel],
                    backstage: %w[yosys_ghdl nextpnr gowin_pack icarus surfer sby openfpgaloader opfs],
                    support: %w[ci_build cloudflare_pages openrouter_api]

  statechart :design_flow do
    state :editing, initial: true, surface: :web_app, description: "編集中。成果物なし、または最新"
    state :loading_tools, surface: :web_app, entry: %w[show_download_progress],
          description: "合成ツールを取得中。進捗と残量を表示"
    state :building, surface: :tool_workers, entry: %w[show_stage_progress],
          description: "合成・配置配線・pack を実行中。工程ごとに進捗"
    state :built, surface: :web_app, entry: %w[show_build_summary],
          description: "ビットストリームがあり、今の版と一致する"
    state :build_failed, surface: :web_app, entry: %w[open_problem_list],
          description: "失敗。問題の一覧を開き、先頭の行へ移れる"
    state :stale, surface: :web_app, entry: %w[mark_artifacts_stale],
          description: "合成後に編集した。書き込む前に合成し直すよう案内"
    state :writing, surface: :tang_nano, entry: %w[show_write_progress],
          description: "書き込み中。消去・書き込み・確認の進捗"
    state :written, surface: :web_app, entry: %w[show_write_result],
          description: "書き込み成功（終了コードとログの両方で判定）"
    state :write_failed, surface: :web_app, entry: %w[show_write_hint],
          description: "書き込み失敗。原因の候補と次の操作を表示"
    on :editing, :build_requested, to: :loading_tools, guard: "tools_not_cached"
    on :editing, :build_requested, to: :building, guard: "tools_cached"
    on :loading_tools, :tools_ready, to: :building
    on :loading_tools, :download_failed, to: :build_failed
    on :building, :build_succeeded, to: :built
    on :building, :build_errored, to: :build_failed
    on :build_failed, :source_edited, to: :editing
    on :build_failed, :build_requested, to: :loading_tools, guard: "tools_not_cached"
    on :build_failed, :build_requested, to: :building, guard: "tools_cached"
    on :building, :build_cancelled, to: :editing
    on :editing, :write_requested, to: :writing, guard: "uploaded_fs_selected && board_idcode_matches"
    on :stale, :write_requested, to: :stale, actions: %w[explain_rebuild_needed]
    on :built, :source_edited, to: :stale
    on :stale, :build_requested, to: :loading_tools, guard: "tools_not_cached"
    on :stale, :build_requested, to: :building, guard: "tools_cached"
    on :built, :write_requested, to: :writing, guard: "board_idcode_matches"
    on :writing, :write_succeeded, to: :written
    on :writing, :write_errored, to: :write_failed
    on :write_failed, :write_requested, to: :writing, guard: "board_idcode_matches"
    on :written, :source_edited, to: :stale
    on :written, :write_requested, to: :writing, guard: "board_idcode_matches"
  end

  statechart :ai_connection do
    state :disconnected, initial: true, surface: :web_app, description: "未接続。送る内容と保存先を説明"
    state :authorizing, surface: :openrouter, description: "OpenRouter の認可画面（同じタブで移動）"
    state :exchanging, surface: :web_app, entry: %w[verify_state],
          description: "state を照合し、code を鍵に交換中"
    state :connected, surface: :web_app, description: "接続済み。鍵の保存先（タブのみ / この端末）を表示"
    state :auth_failed, surface: :web_app, description: "拒否・期限切れ・state 不一致。理由と再試行"
    on :disconnected, :connect_requested, to: :authorizing, guard: "consent_given", actions: %w[store_verifier]
    on :authorizing, :callback_received, to: :exchanging
    on :authorizing, :auth_denied, to: :auth_failed
    on :exchanging, :key_received, to: :connected, actions: %w[discard_verifier]
    on :exchanging, :exchange_failed, to: :auth_failed
    on :auth_failed, :connect_requested, to: :authorizing, guard: "consent_given"
    on :connected, :disconnect_requested, to: :disconnected, actions: %w[erase_key]
  end

  surface :web_app, layer: :web_ui, name: "午後のFPGA の画面"
  surface :tool_workers, layer: :web_ui, name: "Web Worker 上の合成・検証ツール"
  surface :project_store, layer: :web_ui, name: "OPFS のプロジェクト保存"
  surface :tang_nano, layer: :hardware, name: "Tang Nano 1K/4K/9K/20K（WebUSB）"
  surface :openrouter, layer: :cloud_backend, name: "OpenRouter（認可と AI）"

  control :primary_action, surface: :web_app, kind: :button, size_mm: [12, 8],
          touchpoint: "build_progress", fg: "#FFFFFF", bg: "#0B57B0"
  control :write_action, surface: :web_app, kind: :button, size_mm: [12, 8],
          touchpoint: "write_progress", fg: "#FFFFFF", bg: "#1E6B34"
  control :secondary_action, surface: :web_app, kind: :button, size_mm: [10, 8],
          touchpoint: "sim_run", fg: "#0B57B0", bg: "#FFFFFF"
  control :ai_send, surface: :web_app, kind: :button, size_mm: [10, 8],
          touchpoint: "ai_chat", fg: "#FFFFFF", bg: "#0B57B0"
  control :problem_link, surface: :web_app, kind: :link, touchpoint: "problem_list",
          fg: "#8A1C1C", bg: "#FFFFFF"

  feedback :download_progress, trigger: :build_requested, surface: :web_app,
           modality: :visual, latency_ms: 100, progress_indicator: true,
           description: "取得済み / 全体の MB と工程名を出す。2 回目以降はキャッシュ済みと表示"
  feedback :stage_progress, trigger: :tools_ready, surface: :web_app,
           modality: :visual, latency_ms: 100, progress_indicator: true,
           description: "合成・配置配線・pack の工程表示と経過時間"
  feedback :rebuild_needed, trigger: :write_requested, surface: :web_app,
           modality: :text, latency_ms: 100,
           description: "古い成果物は書き込まず、合成し直すボタンを示す"
  feedback :build_summary, trigger: :build_succeeded, surface: :web_app,
           modality: :visual, latency_ms: 200,
           description: "資源使用率・最大周波数・警告数を要約カードで出す"
  feedback :problems_open, trigger: :build_errored, surface: :web_app,
           modality: :text, latency_ms: 200,
           description: "問題の一覧を開き、ファイルと行へ移るリンクを出す"
  feedback :stale_notice, trigger: :source_edited, surface: :web_app,
           modality: :visual, latency_ms: 100,
           description: "成果物に「古い」印を付け、書き込みボタンを合成し直しへ変える"
  feedback :write_progress, trigger: :write_requested, surface: :web_app,
           modality: :visual, latency_ms: 100, progress_indicator: true,
           description: "消去・書き込み・確認の進捗と経過時間"
  feedback :write_result, trigger: :write_succeeded, surface: :web_app,
           modality: :text, latency_ms: 200,
           description: "SRAM / フラッシュ、ボード、ファイル、時刻を書いた結果"
  feedback :write_hint, trigger: :write_errored, surface: :web_app,
           modality: :text, latency_ms: 200,
           description: "IDCODE 不一致・接続切れ・ログの FAIL など原因別の次の操作"
  feedback :ai_exchange, trigger: :callback_received, surface: :web_app,
           modality: :visual, latency_ms: 100, progress_indicator: true,
           description: "OpenRouter から戻った直後に接続中を表示"
  feedback :ai_connected, trigger: :key_received, surface: :web_app,
           modality: :text, latency_ms: 200,
           description: "接続済みと鍵の保存先、OpenRouter の鍵の設定へのリンク"
  feedback :ai_failed, trigger: :exchange_failed, surface: :web_app,
           modality: :text, latency_ms: 200,
           description: "期限切れ・使用済み・state 不一致を区別して再試行を案内"

  experience_loop :edit_build_write,
                  steps: %w[source_edited build_requested build_succeeded write_requested write_succeeded],
                  reward: "ボードの LED が設計どおりに動く", cadence: :moment
  experience_loop :fix_loop,
                  steps: %w[build_errored source_edited build_requested build_succeeded],
                  reward: "問題の一覧が空になる", cadence: :moment

  core_experience "ブラウザーを開くだけで、書いた回路が手元の Tang Nano で動く"
  implementation_spec "CodeMirror 6", "Web Worker 上の WASM ツール", "OPFS", "WebUSB", "OpenRouter OAuth PKCE"

  qcd quality: :high, cost: :low, delivery: :normal,
      rationale: "最初の書き込みと失敗からの回復を最優先にし、AI は利用者が選んだときだけ使う"
end
